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
interface IUniV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}
interface IUniV3Pool {
    function tickSpacing() external view returns (int24);
}
interface IUniV3PositionManager {
    function factory() external view returns (address);
    struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }
    struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    function mint(MintParams calldata params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external payable;
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}
interface IQrosPositionRegistry {
    struct Position {
        address user; uint256 chainId; address positionManager; uint256 tokenId;
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint128 liquidity; uint8 status; uint64 createdAt;
    }
    function registerPosition(bytes32 positionId, address user, address manager, uint256 tokenId, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity) external;
    function updatePosition(bytes32 positionId, uint8 status, uint128 liquidity) external;
    function getPosition(bytes32 positionId) external view returns (Position memory);
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
    mapping(uint24 => bool) public allowedSwapFees;
    mapping(bytes32 => bool) public allowedStrategyPairs;
    uint256 public maxExecutionWindow = 30 minutes;
    event ProtocolConfigUpdated(address swapRouter, address positionManager, address registry);
    event PoolFeeApproval(uint24 fee, bool approved);
    event SwapFeeApproval(uint24 fee, bool approved);
    event StrategyPairApproval(bytes32 indexed strategyId, address indexed token0, address indexed token1, bool approved);
    event MaxExecutionWindowUpdated(uint256 previousWindow, uint256 newWindow);
    event LiquidityPositionCreated(bytes32 indexed executionId, bytes32 indexed positionId, address indexed user, uint256 tokenId, uint128 liquidity);
    event PositionFeesCollected(bytes32 indexed positionId, address indexed user, uint256 amount0, uint256 amount1);
    event PositionLiquidityReduced(bytes32 indexed positionId, address indexed user, uint128 liquidityRemoved, uint256 amount0, uint256 amount1);
    event PositionClosed(bytes32 indexed positionId, address indexed user, uint256 tokenId);
    constructor(address initialOwner, address ledger_) Ownable(initialOwner) { require(ledger_ != address(0), "Invalid ledger"); ledger = ledger_; }
    modifier onlyLedger() { require(msg.sender == ledger, "Only ledger"); _; }
    function configure(address router, address manager, address registry_) external onlyOwner {
        require(
            router.code.length != 0 && manager.code.length != 0 && registry_.code.length != 0,
            "Protocol address has no code"
        );
        address factoryAddress = IUniV3PositionManager(manager).factory();
        require(factoryAddress.code.length != 0, "Invalid Uniswap factory");
        swapRouter = IUniV3SwapRouter(router); positionManager = IUniV3PositionManager(manager); registry = IQrosPositionRegistry(registry_);
        emit ProtocolConfigUpdated(router, manager, registry_);
    }
    function setPoolFee(uint24 fee, bool approved) external onlyOwner { require(fee > 0, "Invalid fee"); allowedPoolFees[fee] = approved; emit PoolFeeApproval(fee, approved); }
    function setSwapFee(uint24 fee, bool approved) external onlyOwner { require(fee > 0, "Invalid fee"); allowedSwapFees[fee] = approved; emit SwapFeeApproval(fee, approved); }
    function setStrategyPair(bytes32 strategyId, address token0, address token1, bool approved) external onlyOwner {
        require(strategyId != bytes32(0) && token0 != address(0) && token0 < token1, "Invalid strategy pair");
        bytes32 key = keccak256(abi.encode(strategyId, token0, token1));
        allowedStrategyPairs[key] = approved;
        emit StrategyPairApproval(strategyId, token0, token1, approved);
    }
    function setMaxExecutionWindow(uint256 newWindow) external onlyOwner {
        require(newWindow >= 1 minutes && newWindow <= 2 hours, "Invalid execution window");
        emit MaxExecutionWindowUpdated(maxExecutionWindow, newWindow);
        maxExecutionWindow = newWindow;
    }
    function execute(bytes32 executionId, address user, address asset, uint256 amount, bytes32 strategyId, bytes calldata adapterData)
        external onlyLedger nonReentrant returns (uint256 spent, uint256 returnedAmount, bytes32 positionId)
    {
        require(address(swapRouter) != address(0) && address(positionManager) != address(0) && address(registry) != address(0), "Adapter not configured");
        require(user != address(0) && amount != 0, "Invalid execution");
        Params memory p = abi.decode(adapterData, (Params));
        require(p.deadline >= block.timestamp && p.deadline <= block.timestamp + maxExecutionWindow, "Invalid execution deadline");
        require(p.token0 < p.token1 && (asset == p.token0 || asset == p.token1), "Invalid token pair");
        require(allowedStrategyPairs[keccak256(abi.encode(strategyId, p.token0, p.token1))], "Strategy pair not approved");
        require(allowedPoolFees[p.poolFee], "Pool fee not approved");
        require(p.tickLower < p.tickUpper && p.swapAmount <= amount, "Invalid strategy bounds");
        if (p.swapAmount == 0) require(p.minSwapOut == 0, "Unexpected swap minimum");
        else require(allowedSwapFees[p.swapFee] && p.minSwapOut != 0, "Swap route not approved");
        IUniV3Factory factory = IUniV3Factory(positionManager.factory());
        address pool = factory.getPool(p.token0, p.token1, p.poolFee);
        require(pool != address(0) && pool.code.length != 0, "Uniswap pool unavailable");
        int24 spacing = IUniV3Pool(pool).tickSpacing();
        require(p.tickLower % spacing == 0 && p.tickUpper % spacing == 0, "Ticks not aligned to pool");
        address outputToken = asset == p.token0 ? p.token1 : p.token0;
        if (p.swapAmount != 0) {
            address swapPool = factory.getPool(asset, outputToken, p.swapFee);
            require(swapPool != address(0) && swapPool.code.length != 0, "Swap pool unavailable");
        }
        IERC20 input = IERC20(asset); IERC20 output = IERC20(outputToken);
        uint256 inputBalance = input.balanceOf(address(this));
        require(inputBalance >= amount, "Input not funded");
        uint256 initialInput = inputBalance - amount;
        uint256 initialOutput = output.balanceOf(address(this));
        uint256 initialToken0 = IERC20(p.token0).balanceOf(address(this)) - (asset == p.token0 ? amount : 0);
        uint256 initialToken1 = IERC20(p.token1).balanceOf(address(this)) - (asset == p.token1 ? amount : 0);
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
        uint256 desired0 = balance0 - initialToken0;
        uint256 desired1 = balance1 - initialToken1;
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
        require(liquidity != 0 && positionManager.ownerOf(tokenId) == address(this), "Invalid minted position");
        positionId = keccak256(abi.encode(block.chainid, address(positionManager), tokenId));
        registry.registerPosition(positionId, user, address(positionManager), tokenId, p.token0, p.token1, p.poolFee, p.tickLower, p.tickUpper, liquidity);
        positionManager.safeTransferFrom(address(this), user, tokenId);
        require(positionManager.ownerOf(tokenId) == user, "NFT delivery failed");
        returnedAmount = input.balanceOf(address(this)) - initialInput;
        require(returnedAmount <= amount, "Input reconciliation");
        spent = amount - returnedAmount;
        if (returnedAmount != 0) input.safeTransfer(ledger, returnedAmount);
        uint256 outputRemainder = output.balanceOf(address(this)) - initialOutput;
        if (outputRemainder != 0) output.safeTransfer(user, outputRemainder);
        emit LiquidityPositionCreated(executionId, positionId, user, tokenId, liquidity);
    }
    /// @notice Collect accrued Uniswap fees. User must approve this adapter for the NFT.
    function collectFees(bytes32 positionId, uint256 deadline) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(block.timestamp <= deadline, "Action expired");
        IQrosPositionRegistry.Position memory p = registry.getPosition(positionId);
        require(p.user == msg.sender && p.status == 1, "Position not active or not owner");
        _requireNftApproval(p);
        (amount0, amount1) = positionManager.collect(IUniV3PositionManager.CollectParams({
            tokenId: p.tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        emit PositionFeesCollected(positionId, msg.sender, amount0, amount1);
    }

    /// @notice Reduce liquidity while keeping the NFT active. User must approve this adapter.
    function reduceLiquidity(bytes32 positionId, uint128 liquidityToRemove, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        external nonReentrant returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= deadline, "Action expired");
        IQrosPositionRegistry.Position memory p = registry.getPosition(positionId);
        require(p.user == msg.sender && p.status == 1, "Position not active or not owner");
        require(liquidityToRemove != 0 && liquidityToRemove <= p.liquidity, "Invalid liquidity amount");
        _requireNftApproval(p);
        (amount0, amount1) = positionManager.decreaseLiquidity(IUniV3PositionManager.DecreaseLiquidityParams({
            tokenId: p.tokenId, liquidity: liquidityToRemove, amount0Min: amount0Min,
            amount1Min: amount1Min, deadline: deadline
        }));
        positionManager.collect(IUniV3PositionManager.CollectParams({
            tokenId: p.tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        uint128 remaining = p.liquidity - liquidityToRemove;
        registry.updatePosition(positionId, 1, remaining);
        emit PositionLiquidityReduced(positionId, msg.sender, liquidityToRemove, amount0, amount1);
    }

    /// @notice Fully close a position, collect proceeds/fees, burn NFT and update registry.
    function closePosition(bytes32 positionId, uint256 amount0Min, uint256 amount1Min, uint256 deadline)
        external nonReentrant returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= deadline, "Action expired");
        IQrosPositionRegistry.Position memory p = registry.getPosition(positionId);
        require(p.user == msg.sender && p.status == 1, "Position not active or not owner");
        _requireNftApproval(p);
        if (p.liquidity != 0) {
            (amount0, amount1) = positionManager.decreaseLiquidity(IUniV3PositionManager.DecreaseLiquidityParams({
                tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: amount0Min,
                amount1Min: amount1Min, deadline: deadline
            }));
        }
        positionManager.collect(IUniV3PositionManager.CollectParams({
            tokenId: p.tokenId, recipient: msg.sender, amount0Max: type(uint128).max, amount1Max: type(uint128).max
        }));
        positionManager.burn(p.tokenId);
        registry.updatePosition(positionId, 3, 0);
        emit PositionClosed(positionId, msg.sender, p.tokenId);
    }

    function _requireNftApproval(IQrosPositionRegistry.Position memory p) internal view {
        require(positionManager.ownerOf(p.tokenId) == p.user, "NFT not held by user");
        require(
            positionManager.getApproved(p.tokenId) == address(this) ||
            positionManager.isApprovedForAll(p.user, address(this)),
            "Approve adapter for NFT"
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        require(msg.sender == address(positionManager), "Unexpected NFT"); return IERC721Receiver.onERC721Received.selector;
    }
}