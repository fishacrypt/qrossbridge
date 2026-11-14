
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title QrosIntentGateway
 * @notice QMS-side stablecoin intake and LP settlement gateway.
 * @dev The relayer coordinates destination reservation and source settlement.
 *      Routes use an owner-configured nominal 1:1 rate, less the configured fee.
 *      Only matching stablecoin routes should be enabled in this MVP.
 */
contract QrosIntentGateway is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Pending,
        Active,
        Failed,
        Closed
    }

    struct AssetRoute {
        address destinationAsset;
        address lp;
        uint16 feeBps;
        bool enabled;
    }

    struct Request {
        address user;
        address sourceAsset;
        address destinationAsset;
        address lp;
        uint256 sourceAmount;
        uint256 destinationAmount;
        bytes32 strategyId;
        Status status;
    }

    uint256 public immutable destinationChainId;
    address public relayer;
    uint256 public nonce;

    mapping(address => AssetRoute) public assetRoutes;
    mapping(bytes32 => Request) public requests;

    event AssetRouteUpdated(
        address indexed sourceAsset,
        address indexed destinationAsset,
        address indexed lp,
        uint16 feeBps,
        bool enabled
    );

    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);

    event ExecutionRequested(
        bytes32 indexed requestId,
        address indexed user,
        address indexed sourceAsset,
        address destinationAsset,
        uint256 sourceAmount,
        uint256 destinationAmount,
        uint256 destinationChainId,
        bytes32 strategyId
    );

    event ExecutionSettled(
        bytes32 indexed requestId,
        address indexed lp,
        address indexed sourceAsset,
        uint256 amount
    );

    event ExecutionFailed(bytes32 indexed requestId);

    event RefundClaimed(
        bytes32 indexed requestId,
        address indexed user,
        uint256 amount
    );

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Not relayer");
        _;
    }

    constructor(
        address initialOwner,
        address initialRelayer,
        uint256 destinationChainId_
    ) Ownable(initialOwner) {
        require(initialRelayer != address(0), "Invalid relayer");
        require(
            destinationChainId_ != 0 &&
            destinationChainId_ != block.chainid,
            "Invalid destination"
        );

        relayer = initialRelayer;
        destinationChainId = destinationChainId_;
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "Invalid relayer");

        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function setAssetRoute(
        address sourceAsset,
        address destinationAsset,
        address lp,
        uint16 feeBps,
        bool enabled
    ) external onlyOwner {
        require(sourceAsset != address(0), "Invalid source");
        require(
            !enabled || destinationAsset != address(0),
            "Invalid destination asset"
        );
        require(!enabled || lp != address(0), "Invalid LP");
        require(feeBps < 10_000, "Invalid fee");

        assetRoutes[sourceAsset] = AssetRoute({
            destinationAsset: destinationAsset,
            lp: lp,
            feeBps: feeBps,
            enabled: enabled
        });

        emit AssetRouteUpdated(
            sourceAsset,
            destinationAsset,
            lp,
            feeBps,
            enabled
        );
    }

    function requestExecution(
        address sourceAsset,
        uint256 amount,
        bytes32 strategyId
    )
        external
        whenNotPaused
        nonReentrant
        returns (bytes32 requestId)
    {
        AssetRoute memory route = assetRoutes[sourceAsset];

        require(route.enabled, "Route disabled");
        require(amount > 0, "Amount is zero");

        uint256 fee = (amount * route.feeBps) / 10_000;
        uint256 destinationAmount = amount - fee;

        require(destinationAmount > 0, "Amount below minimum");

        uint256 currentNonce = nonce++;

        requestId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                msg.sender,
                currentNonce
            )
        );

        IERC20(sourceAsset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );

        requests[requestId] = Request({
            user: msg.sender,
            sourceAsset: sourceAsset,
            destinationAsset: route.destinationAsset,
            lp: route.lp,
            sourceAmount: amount,
            destinationAmount: destinationAmount,
            strategyId: strategyId,
            status: Status.Pending
        });

        emit ExecutionRequested(
            requestId,
            msg.sender,
            sourceAsset,
            route.destinationAsset,
            amount,
            destinationAmount,
            destinationChainId,
            strategyId
        );
    }

    /**
     * @notice Settles source funds to the LP after destination liquidity
     *         has been reserved and verified by the relayer.
     */
    function markExecuted(bytes32 requestId)
        external
        onlyRelayer
        nonReentrant
    {
        Request storage request = requests[requestId];

        require(request.status == Status.Pending, "Request not pending");

        request.status = Status.Active;

        IERC20(request.sourceAsset).safeTransfer(
            request.lp,
            request.sourceAmount
        );

        emit ExecutionSettled(
            requestId,
            request.lp,
            request.sourceAsset,
            request.sourceAmount
        );
    }

    function markFailed(bytes32 requestId) external onlyRelayer {
        Request storage request = requests[requestId];

        require(request.status == Status.Pending, "Request not pending");

        request.status = Status.Failed;

        emit ExecutionFailed(requestId);
    }

    function claimRefund(bytes32 requestId) external nonReentrant {
        Request storage request = requests[requestId];

        require(request.user == msg.sender, "Not request owner");
        require(request.status == Status.Failed, "Refund unavailable");

        request.status = Status.Closed;

        IERC20(request.sourceAsset).safeTransfer(
            request.user,
            request.sourceAmount
        );

        emit RefundClaimed(
            requestId,
            request.user,
            request.sourceAmount
        );
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

/**
 * @title QrosLiquidityVault
 * @notice Base Sepolia destination stablecoin custody vault.
 * @dev Holds prefunded stablecoins and issues withdrawable test positions.
 *      This is not yet an integration with an external DeFi protocol.
 */
contract QrosLiquidityVault is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum PositionStatus {
        None,
        Reserved,
        Active,
        Closed,
        Cancelled
    }

    struct Position {
        address user;
        address asset;
        uint256 amount;
        bytes32 strategyId;
        PositionStatus status;
    }

    uint256 public immutable sourceChainId;
    address public relayer;

    mapping(address => bool) public supportedAssets;

    mapping(address => uint256) public availableLiquidity;
    mapping(address => uint256) public reservedLiquidity;
    mapping(address => uint256) public activeLiquidity;

    mapping(bytes32 => Position) public positions;
    mapping(bytes32 => bool) public processedRequests;

    event AssetSupportUpdated(address indexed asset, bool supported);

    event RelayerUpdated(
        address indexed previousRelayer,
        address indexed newRelayer
    );

    event LiquidityFunded(address indexed asset, uint256 amount);

    event UnusedLiquidityWithdrawn(
        address indexed asset,
        address indexed recipient,
        uint256 amount
    );

    event PositionReserved(
        bytes32 indexed requestId,
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    event PositionActivated(bytes32 indexed requestId);

    event PositionCancelled(bytes32 indexed requestId);

    event PositionClosed(
        bytes32 indexed requestId,
        address indexed user,
        address indexed asset,
        uint256 amount
    );

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Not relayer");
        _;
    }

    constructor(
        address initialOwner,
        address initialRelayer,
        uint256 sourceChainId_
    ) Ownable(initialOwner) {
        require(initialRelayer != address(0), "Invalid relayer");
        require(
            sourceChainId_ != 0 &&
            sourceChainId_ != block.chainid,
            "Invalid source"
        );

        relayer = initialRelayer;
        sourceChainId = sourceChainId_;
    }

    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "Invalid relayer");

        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function setAssetSupport(
        address asset,
        bool supported
    ) external onlyOwner {
        require(asset != address(0), "Invalid asset");

        supportedAssets[asset] = supported;

        emit AssetSupportUpdated(asset, supported);
    }

    function fundLiquidity(
        address asset,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(supportedAssets[asset], "Asset not supported");
        require(amount > 0, "Amount is zero");

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        IERC20(asset).safeTransferFrom(
            msg.sender,
            address(this),
            amount
        );

        uint256 received =
            IERC20(asset).balanceOf(address(this)) - balanceBefore;

        require(received == amount, "Unsupported transfer fee");

        availableLiquidity[asset] += amount;

        emit LiquidityFunded(asset, amount);
    }

    function withdrawUnusedLiquidity(
        address asset,
        address recipient,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        require(
            amount > 0 && amount <= availableLiquidity[asset],
            "Insufficient free liquidity"
        );

        availableLiquidity[asset] -= amount;

        IERC20(asset).safeTransfer(recipient, amount);

        emit UnusedLiquidityWithdrawn(asset, recipient, amount);
    }

    /**
     * @notice Reserves real destination tokens for a cross-chain request.
     *         The position cannot be withdrawn until source settlement.
     */
    function reserveRequest(
        bytes32 requestId,
        address user,
        address asset,
        uint256 amount,
        bytes32 strategyId
    ) external onlyRelayer whenNotPaused {
        require(requestId != bytes32(0), "Invalid request ID");
        require(!processedRequests[requestId], "Request already processed");
        require(user != address(0), "Invalid user");
        require(supportedAssets[asset], "Asset not supported");
        require(amount > 0, "Amount is zero");
        require(
            availableLiquidity[asset] >= amount,
            "Insufficient destination liquidity"
        );

        processedRequests[requestId] = true;

        availableLiquidity[asset] -= amount;
        reservedLiquidity[asset] += amount;

        positions[requestId] = Position({
            user: user,
            asset: asset,
            amount: amount,
            strategyId: strategyId,
            status: PositionStatus.Reserved
        });

        emit PositionReserved(requestId, user, asset, amount);
    }

    /**
     * @notice Called after the relayer confirms source-side LP settlement.
     */
    function activatePosition(
        bytes32 requestId
    ) external onlyRelayer {
        Position storage position = positions[requestId];

        require(
            position.status == PositionStatus.Reserved,
            "Position not reserved"
        );

        position.status = PositionStatus.Active;

        reservedLiquidity[position.asset] -= position.amount;
        activeLiquidity[position.asset] += position.amount;

        emit PositionActivated(requestId);
    }

    /**
     * @notice Releases a reservation if source settlement did not happen.
     */
    function cancelReservation(
        bytes32 requestId
    ) external onlyRelayer {
        Position storage position = positions[requestId];

        require(
            position.status == PositionStatus.Reserved,
            "Position not reserved"
        );

        position.status = PositionStatus.Cancelled;

        reservedLiquidity[position.asset] -= position.amount;
        availableLiquidity[position.asset] += position.amount;

        emit PositionCancelled(requestId);
    }

    /**
     * @notice User withdraws the actual destination stablecoin.
     */
    function closePosition(
        bytes32 requestId
    ) external nonReentrant {
        Position storage position = positions[requestId];

        require(
            position.status == PositionStatus.Active,
            "Position not active"
        );
        require(position.user == msg.sender, "Not position owner");

        position.status = PositionStatus.Closed;

        activeLiquidity[position.asset] -= position.amount;

        IERC20(position.asset).safeTransfer(
            position.user,
            position.amount
        );

        emit PositionClosed(
            requestId,
            position.user,
            position.asset,
            position.amount
        );
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
