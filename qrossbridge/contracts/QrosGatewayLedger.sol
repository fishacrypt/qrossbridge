// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IQrosExecutionAdapter.sol";

/**
 * @title QrosGatewayLedger
 * @notice Custodial ledger for persistent, user-owned QROS balances.
 * @dev Bridge verification and protocol execution are delegated to explicitly
 *      configured adapters. The ledger never treats a deposit as an execution.
 */
contract QrosGatewayLedger is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TransferStatus { None, InTransit, Finalized, Cancelled, Recovered }
    enum ExecutionStatus { None, Reserved, Completed, Released }

    struct Balance {
        uint256 available;
        uint256 inTransit;
        uint256 reserved;
        uint256 deployed;
    }

    struct OutboundTransfer {
        address user;
        address asset;
        address destinationAsset;
        address recipient;
        uint256 amount;
        uint256 destinationChainId;
        TransferStatus status;
    }

    struct Execution {
        address user;
        address asset;
        uint256 amount;
        bytes32 strategyId;
        ExecutionStatus status;
    }

    mapping(address => bool) public supportedAssets;
    mapping(address => mapping(address => Balance)) private balances;

    // Liabilities are tokens still held by this ledger for users:
    // available + inTransit + reserved. Deployed is informational, external value.
    mapping(address => uint256) public custodyLiability;

    // Legacy default adapter plus asset-specific adapters for a unified multi-asset Gateway.
    // Each asset can use its own settlement rail (e.g. QMS bridge or prefunded stablecoin liquidity).
    address public settlementAdapter;
    mapping(address => address) public settlementAdapters;
    address public executionAdapter;
    address public executionRouter;
    address public transferCoordinator;
    uint256 public executionNonce;

    mapping(bytes32 => OutboundTransfer) public outboundTransfers;
    mapping(bytes32 => bool) public processedInboundTransfers;
    mapping(bytes32 => Execution) public executions;

    event AssetSupportUpdated(address indexed asset, bool supported);
    event SettlementAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event AssetSettlementAdapterUpdated(address indexed asset, address indexed previousAdapter, address indexed newAdapter);
    event ExecutionAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event ExecutionRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event TransferCoordinatorUpdated(address indexed previousCoordinator, address indexed newCoordinator);
    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, address indexed recipient, uint256 amount);
    event OutboundTransferStarted(bytes32 indexed transferId, address indexed user, address indexed asset, uint256 amount, uint256 destinationChainId, address destinationAsset, address recipient);
    event OutboundTransferFinalized(bytes32 indexed transferId, address indexed adapter, uint256 amount);
    event OutboundTransferCancelled(bytes32 indexed transferId, address indexed user, uint256 amount);
    event OutboundTransferRecovered(bytes32 indexed transferId, address indexed user, uint256 amount);
    event InboundTransferCredited(bytes32 indexed transferId, address indexed user, address indexed asset, uint256 amount, uint256 sourceChainId);
    event ExecutionReserved(bytes32 indexed executionId, address indexed user, address indexed asset, uint256 amount, bytes32 strategyId);
    event ExecutionCompleted(bytes32 indexed executionId, address indexed adapter, uint256 amount);
    event ExecutionReleased(bytes32 indexed executionId, address indexed user, uint256 amount);
    event ExecutionSettled(bytes32 indexed executionId, uint256 spent, uint256 returnedToAvailable, bytes32 positionId);
    event PositionProceedsCredited(address indexed user, address indexed asset, uint256 amount, address indexed deployedAsset, uint256 deployedReduction);
    event DeployedCostBasisReleased(address indexed user, address indexed asset, uint256 amount);

    modifier onlySettlementAdapterForAsset(address asset) {
        address configured = settlementAdapters[asset];
        if (configured == address(0)) configured = settlementAdapter;
        require(configured != address(0) && msg.sender == configured, "Not settlement adapter for asset");
        _;
    }

    modifier onlySettlementAdapterForTransfer(bytes32 transferId) {
        address asset = outboundTransfers[transferId].asset;
        address configured = settlementAdapters[asset];
        if (configured == address(0)) configured = settlementAdapter;
        require(asset != address(0) && configured != address(0) && msg.sender == configured, "Not settlement adapter for transfer");
        _;
    }

    modifier onlyExecutionAdapter() {
        require(msg.sender == executionAdapter && executionAdapter != address(0), "Not execution adapter");
        _;
    }

    modifier onlyExecutionRouter() {
        require(msg.sender == executionRouter && executionRouter != address(0), "Not execution router");
        _;
    }

    modifier onlyTransferCoordinator() {
        require(msg.sender == transferCoordinator && transferCoordinator != address(0), "Not transfer coordinator");
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        require(initialOwner != address(0), "Invalid owner");
    }

    function setAssetSupport(address asset, bool supported) external onlyOwner {
        require(asset != address(0), "Invalid asset");
        if (!supported) require(custodyLiability[asset] == 0, "Asset has outstanding liabilities");
        supportedAssets[asset] = supported;
        emit AssetSupportUpdated(asset, supported);
    }

    function setSettlementAdapter(address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        emit SettlementAdapterUpdated(settlementAdapter, adapter);
        settlementAdapter = adapter;
    }

    /// @notice Assign a dedicated settlement adapter to one supported asset.
    /// @dev Allows QMS/wQMS and each stablecoin to use distinct settlement rails on one ledger.
    function setSettlementAdapterForAsset(address asset, address adapter) external onlyOwner {
        require(asset != address(0) && supportedAssets[asset], "Asset not supported");
        require(adapter != address(0), "Invalid adapter");
        address previous = settlementAdapters[asset];
        settlementAdapters[asset] = adapter;
        emit AssetSettlementAdapterUpdated(asset, previous, adapter);
    }

    function setExecutionAdapter(address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        emit ExecutionAdapterUpdated(executionAdapter, adapter);
        executionAdapter = adapter;
    }

    function setExecutionRouter(address router) external onlyOwner {
        require(router != address(0), "Invalid router");
        emit ExecutionRouterUpdated(executionRouter, router);
        executionRouter = router;
    }

    function setTransferCoordinator(address coordinator) external onlyOwner {
        require(coordinator != address(0), "Invalid coordinator");
        emit TransferCoordinatorUpdated(transferCoordinator, coordinator);
        transferCoordinator = coordinator;
    }

    function getBalance(address user, address asset) external view returns (
        uint256 available, uint256 inTransit, uint256 reserved, uint256 deployed
    ) {
        Balance storage b = balances[user][asset];
        return (b.available, b.inTransit, b.reserved, b.deployed);
    }

    function deposit(address asset, uint256 amount)
        external whenNotPaused nonReentrant returns (uint256 received)
    {
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - beforeBalance;
        require(received == amount, "Fee-on-transfer unsupported");
        balances[msg.sender][asset].available += received;
        custodyLiability[asset] += received;
        emit Deposited(msg.sender, asset, received);
    }

    function withdraw(address asset, uint256 amount, address recipient) external nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        require(amount != 0, "Amount is zero");
        Balance storage b = balances[msg.sender][asset];
        require(b.available >= amount, "Insufficient available balance");
        b.available -= amount;
        custodyLiability[asset] -= amount;
        IERC20(asset).safeTransfer(recipient, amount);
        emit Withdrawn(msg.sender, asset, recipient, amount);
    }

    function beginOutboundTransfer(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address recipient
    ) external whenNotPaused {
        _beginOutboundTransfer(msg.sender, transferId, asset, amount, destinationChainId, destinationAsset, recipient);
    }

    function beginOutboundTransferFor(
        address user, bytes32 transferId, address asset, uint256 amount,
        uint256 destinationChainId, address destinationAsset, address recipient
    ) external onlyTransferCoordinator whenNotPaused {
        _beginOutboundTransfer(user, transferId, asset, amount, destinationChainId, destinationAsset, recipient);
    }

    function _beginOutboundTransfer(
        address user, bytes32 transferId, address asset, uint256 amount,
        uint256 destinationChainId, address destinationAsset, address recipient
    ) internal {
        require(user != address(0) && transferId != bytes32(0), "Invalid user or transfer ID");
        require(outboundTransfers[transferId].status == TransferStatus.None, "Transfer ID used");
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination chain");
        require(destinationAsset != address(0) && recipient != address(0), "Invalid destination");
        Balance storage b = balances[user][asset];
        require(b.available >= amount, "Insufficient available balance");
        b.available -= amount;
        b.inTransit += amount;
        outboundTransfers[transferId] = OutboundTransfer({
            user: user, asset: asset, destinationAsset: destinationAsset, recipient: recipient,
            amount: amount, destinationChainId: destinationChainId, status: TransferStatus.InTransit
        });
        emit OutboundTransferStarted(transferId, user, asset, amount, destinationChainId, destinationAsset, recipient);
    }

    /// @notice The settlement adapter calls this only in the transaction that
    ///         initiates the underlying source-chain settlement.
    function finalizeOutboundTransfer(bytes32 transferId) external onlySettlementAdapterForTransfer(transferId) nonReentrant {
        OutboundTransfer storage transfer = outboundTransfers[transferId];
        require(transfer.status == TransferStatus.InTransit, "Transfer not in transit");
        transfer.status = TransferStatus.Finalized;
        balances[transfer.user][transfer.asset].inTransit -= transfer.amount;
        custodyLiability[transfer.asset] -= transfer.amount;
        IERC20(transfer.asset).safeTransfer(msg.sender, transfer.amount);
        emit OutboundTransferFinalized(transferId, msg.sender, transfer.amount);
    }

    function cancelOutboundTransfer(bytes32 transferId) external onlySettlementAdapterForTransfer(transferId) {
        OutboundTransfer storage transfer = outboundTransfers[transferId];
        require(transfer.status == TransferStatus.InTransit, "Transfer not in transit");
        transfer.status = TransferStatus.Cancelled;
        Balance storage b = balances[transfer.user][transfer.asset];
        b.inTransit -= transfer.amount;
        b.available += transfer.amount;
        emit OutboundTransferCancelled(transferId, transfer.user, transfer.amount);
    }

    /// @notice Recover funds returned by a settlement adapter after source finalization.
    /// @dev The adapter must return the exact source asset to this ledger before calling.
    ///      This is distinct from cancellation, which is only valid before finalization.
    function recoverFinalizedOutboundTransfer(bytes32 transferId) external onlySettlementAdapter nonReentrant {
        OutboundTransfer storage transfer = outboundTransfers[transferId];
        require(transfer.status == TransferStatus.Finalized, "Transfer not finalized");
        require(
            IERC20(transfer.asset).balanceOf(address(this)) >= custodyLiability[transfer.asset] + transfer.amount,
            "Recovery funds not received"
        );
        transfer.status = TransferStatus.Recovered;
        balances[transfer.user][transfer.asset].available += transfer.amount;
        custodyLiability[transfer.asset] += transfer.amount;
        emit OutboundTransferRecovered(transferId, transfer.user, transfer.amount);
    }

    /// @notice Adapter must prove settlement and transfer destination tokens
    ///         into this ledger in the same transaction before calling.
    function creditInboundTransfer(
        bytes32 transferId, address user, address asset, uint256 amount, uint256 sourceChainId
    ) external onlySettlementAdapterForAsset(asset) whenNotPaused {
        require(transferId != bytes32(0), "Invalid transfer ID");
        require(!processedInboundTransfers[transferId], "Transfer already credited");
        require(user != address(0), "Invalid user");
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(sourceChainId != 0 && sourceChainId != block.chainid, "Invalid source chain");
        require(IERC20(asset).balanceOf(address(this)) >= custodyLiability[asset] + amount, "Inbound funds not received");
        processedInboundTransfers[transferId] = true;
        balances[user][asset].available += amount;
        custodyLiability[asset] += amount;
        emit InboundTransferCredited(transferId, user, asset, amount, sourceChainId);
    }

    function reserveExecution(address asset, uint256 amount, bytes32 strategyId)
        external whenNotPaused returns (bytes32 executionId)
    {
        executionId = _reserveExecution(msg.sender, asset, amount, strategyId);
    }

    function reserveExecutionFor(address user, address asset, uint256 amount, bytes32 strategyId)
        external onlyExecutionRouter whenNotPaused returns (bytes32 executionId)
    {
        executionId = _reserveExecution(user, asset, amount, strategyId);
    }

    function _reserveExecution(address user, address asset, uint256 amount, bytes32 strategyId)
        internal returns (bytes32 executionId)
    {
        require(user != address(0), "Invalid user");
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(strategyId != bytes32(0), "Invalid strategy");
        Balance storage b = balances[user][asset];
        require(b.available >= amount, "Insufficient available balance");
        executionId = keccak256(abi.encode(block.chainid, address(this), user, executionNonce++));
        b.available -= amount;
        b.reserved += amount;
        executions[executionId] = Execution(user, asset, amount, strategyId, ExecutionStatus.Reserved);
        emit ExecutionReserved(executionId, user, asset, amount, strategyId);
    }

    /// @notice Atomic adapter execution. If the adapter fails, all ledger and
    ///         token movements revert. Unspent input is returned to available.
    function executeReserved(bytes32 executionId, bytes calldata adapterData)
        external onlyExecutionRouter nonReentrant returns (bytes32 positionId)
    {
        Execution storage execution = executions[executionId];
        require(execution.status == ExecutionStatus.Reserved, "Execution not reserved");
        require(executionAdapter != address(0), "Execution adapter not set");

        address asset = execution.asset;
        uint256 amount = execution.amount;
        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));

        execution.status = ExecutionStatus.Completed;
        Balance storage b = balances[execution.user][asset];
        b.reserved -= amount;

        token.safeTransfer(executionAdapter, amount);
        (uint256 spent, uint256 returnedAmount, bytes32 createdPositionId) =
            IQrosExecutionAdapter(executionAdapter).execute(
                executionId, execution.user, asset, amount, execution.strategyId, adapterData
            );

        require(spent <= amount && returnedAmount == amount - spent, "Invalid adapter accounting");
        require(token.balanceOf(address(this)) == balanceBefore - spent, "Adapter token reconciliation failed");

        b.available += returnedAmount;
        b.deployed += spent;
        custodyLiability[asset] -= spent;
        positionId = createdPositionId;

        emit ExecutionCompleted(executionId, executionAdapter, spent);
        emit ExecutionSettled(executionId, spent, returnedAmount, positionId);
    }

    /// @dev Legacy adapter handoff retained for backwards compatibility.
    function completeExecution(bytes32 executionId) external onlyExecutionAdapter nonReentrant {
        Execution storage execution = executions[executionId];
        require(execution.status == ExecutionStatus.Reserved, "Execution not reserved");
        execution.status = ExecutionStatus.Completed;
        Balance storage b = balances[execution.user][execution.asset];
        b.reserved -= execution.amount;
        b.deployed += execution.amount;
        custodyLiability[execution.asset] -= execution.amount;
        IERC20(execution.asset).safeTransfer(msg.sender, execution.amount);
        emit ExecutionCompleted(executionId, msg.sender, execution.amount);
    }

    function releaseExecution(bytes32 executionId) external nonReentrant {
        Execution storage execution = executions[executionId];
        require(execution.status == ExecutionStatus.Reserved, "Execution not reserved");
        require(msg.sender == execution.user || msg.sender == executionAdapter, "Not authorized to release");
        _releaseExecution(executionId, execution);
    }

    function releaseExecutionForRouter(bytes32 executionId) external onlyExecutionRouter nonReentrant {
        Execution storage execution = executions[executionId];
        require(execution.status == ExecutionStatus.Reserved, "Execution not reserved");
        _releaseExecution(executionId, execution);
    }

    function _releaseExecution(bytes32 executionId, Execution storage execution) internal {
        execution.status = ExecutionStatus.Released;
        Balance storage b = balances[execution.user][execution.asset];
        b.reserved -= execution.amount;
        b.available += execution.amount;
        emit ExecutionReleased(executionId, execution.user, execution.amount);
    }

    /// @notice Reconcile verified position proceeds and release the position's
    ///         allocated deployed cost basis. The adapter must transfer proceeds
    ///         into this ledger in the same transaction before calling.
    function creditPositionProceeds(
        address user, address asset, uint256 amount,
        address deployedAsset, uint256 deployedReduction
    ) external onlyExecutionAdapter nonReentrant {
        require(user != address(0), "Invalid proceeds owner");
        require(amount != 0 || deployedReduction != 0, "Empty position settlement");
        if (amount != 0) require(supportedAssets[asset], "Proceeds asset not supported");
        Balance storage deployedBalance = balances[user][deployedAsset];
        require(deployedBalance.deployed >= deployedReduction, "Deployed balance underflow");
        if (amount != 0) {
            require(
                IERC20(asset).balanceOf(address(this)) >= custodyLiability[asset] + amount,
                "Position proceeds not received"
            );
            balances[user][asset].available += amount;
            custodyLiability[asset] += amount;
        }
        if (deployedReduction != 0) deployedBalance.deployed -= deployedReduction;
        emit PositionProceedsCredited(user, asset, amount, deployedAsset, deployedReduction);
    }

    /// @notice Release a position's tracked deployed cost basis when proceeds
    ///         are sent directly to the user's wallet rather than Gateway.
    function releaseDeployedCostBasis(address user, address deployedAsset, uint256 amount)
        external onlyExecutionAdapter
    {
        require(user != address(0) && amount != 0, "Invalid cost basis release");
        Balance storage b = balances[user][deployedAsset];
        require(b.deployed >= amount, "Deployed balance underflow");
        b.deployed -= amount;
        emit DeployedCostBasisReleased(user, deployedAsset, amount);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
