// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "../interfaces/IQrosExecutionAdapter.sol";

interface IUniV3SwapRouter {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
interface IUniV3PositionManager {
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
interface IQrosPositionRegistry {
    function registerPosition(bytes32 positionId, address user, address manager, uint256 tokenId, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity) external;
}

/// @notice Executes a signed single-asset-to-Uniswap-V3 LP strategy.
/// @dev Router binds the complete encoded Params bytes to the user's EIP-712 intent.
contract UniswapV3LiquidityAdapter is Ownable, ReentrancyGuard, IERC721Receiver, IQrosExecutionAdapter {
    using SafeERC20 for IERC20;
    struct Params {
        address token0; address token1; uint24 poolFee; uint24 swapFee;
        uint256 swapAmount; uint256 minSwapOut; int24 tickLower; int24 tickUpper;
        uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }
    address public immutable ledger;
    IUniV3SwapRouter public swapRouter;
    IUniV3PositionManager public positionManager;
    IQrosPositionRegistry public registry;
    mapping(uint24 => bool) public allowedPoolFees;
    event ProtocolConfigUpdated(address swapRouter, address positionManager, address registry);
    event PoolFeeApproval(uint24 fee, bool approved);
    event LiquidityPositionCreated(bytes32 indexed executionId, bytes32 indexed positionId, address indexed user, uint256 tokenId, uint128 liquidity);
    constructor(address initialOwner, address ledger_) Ownable(initialOwner) { require(ledger_ != address(0), "Invalid ledger"); ledger = ledger_; }
    modifier onlyLedger() { require(msg.sender == ledger, "Only ledger"); _; }
    function configure(address router, address manager, address registry_) external onlyOwner {
        require(router != address(0) && manager != address(0) && registry_ != address(0), "Invalid protocol address");
        swapRouter = IUniV3SwapRouter(router); positionManager = IUniV3PositionManager(manager); registry = IQrosPositionRegistry(registry_);
        emit ProtocolConfigUpdated(router, manager, registry_);
    }
    function setPoolFee(uint24 fee, bool approved) external onlyOwner { require(fee > 0, "Invalid fee"); allowedPoolFees[fee] = approved; emit PoolFeeApproval(fee, approved); }
    function execute(bytes32 executionId, address user, address asset, uint256 amount, bytes32, bytes calldata adapterData)
        external onlyLedger nonReentrant returns (uint256 spent, uint256 returnedAmount, bytes32 positionId)
    {
        require(address(swapRouter) != address(0) && address(positionManager) != address(0) && address(registry) != address(0), "Adapter not configured");
        require(user != address(0) && amount != 0, "Invalid execution");
        Params memory p = abi.decode(adapterData, (Params));
        require(block.timestamp <= p.deadline, "Execution expired");
        require(p.token0 < p.token1 && (asset == p.token0 || asset == p.token1), "Invalid token pair");
        require(allowedPoolFees[p.poolFee], "Pool fee not approved");
        require(p.tickLower < p.tickUpper && p.swapAmount <= amount, "Invalid strategy bounds");
        address outputToken = asset == p.token0 ? p.token1 : p.token0;
        IERC20 input = IERC20(asset); IERC20 output = IERC20(outputToken);
        uint256 initialInput = input.balanceOf(address(this));
        uint256 initialOutput = output.balanceOf(address(this));
        if (p.swapAmount != 0) {
            input.forceApprove(address(swapRouter), p.swapAmount);
            swapRouter.exactInputSingle(IUniV3SwapRouter.ExactInputSingleParams({
                tokenIn: asset, tokenOut: outputToken, fee: p.swapFee, recipient: address(this),
                deadline: p.deadline, amountIn: p.swapAmount, amountOutMinimum: p.minSwapOut, sqrtPriceLimitX96: 0
            }));
            input.forceApprove(address(swapRouter), 0);
        }
        uint256 balance0 = IERC20(p.token0).balanceOf(address(this));
        uint256 balance1 = IERC20(p.token1).balanceOf(address(this));
        uint256 desired0 = balance0 - initialInput;
        uint256 desired1 = balance1 - initialOutput;
        require(desired0 != 0 && desired1 != 0, "Both pool assets required");
        IERC20(p.token0).forceApprove(address(positionManager), desired0);
        IERC20(p.token1).forceApprove(address(positionManager), desired1);
        (uint256 tokenId, uint128 liquidity,,) = positionManager.mint(IUniV3PositionManager.MintParams({
            token0: p.token0, token1: p.token1, fee: p.poolFee, tickLower: p.tickLower, tickUpper: p.tickUpper,
            amount0Desired: desired0, amount1Desired: desired1, amount0Min: p.amount0Min, amount1Min: p.amount1Min,
            recipient: address(this), deadline: p.deadline
        }));
        IERC20(p.token0).forceApprove(address(positionManager), 0);
        IERC20(p.token1).forceApprove(address(positionManager), 0);
        positionId = keccak256(abi.encode(block.chainid, address(positionManager), tokenId));
        registry.registerPosition(positionId, user, address(positionManager), tokenId, p.token0, p.token1, p.poolFee, p.tickLower, p.tickUpper, liquidity);
        positionManager.safeTransferFrom(address(this), user, tokenId);
        returnedAmount = input.balanceOf(address(this)) - initialInput;
        require(returnedAmount <= amount, "Input reconciliation");
        spent = amount - returnedAmount;
        if (returnedAmount != 0) input.safeTransfer(ledger, returnedAmount);
        uint256 outputRemainder = output.balanceOf(address(this)) - initialOutput;
        if (outputRemainder != 0) output.safeTransfer(user, outputRemainder);
        emit LiquidityPositionCreated(executionId, positionId, user, tokenId, liquidity);
    }
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(positionManager), "Unexpected NFT"); return IERC721Receiver.onERC721Received.selector;
    }
}