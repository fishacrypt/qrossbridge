// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title QrosGatewayLedger
 * @notice Custodial accounting ledger for user-owned QROS Gateway balances.
 * @dev This contract is an accounting and custody primitive. It does not itself
 *      bridge assets, verify CCTP attestations, execute swaps or mint LP NFTs.
 *      Those actions belong to separately authorized adapters.
 */
contract QrosGatewayLedger is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum TransferStatus {
        None,
        InTransit,
        Finalized,
        Cancelled
    }

    enum ExecutionStatus {
        None,
        Reserved,
        Completed,
        Released
    }

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

    // Available + inTransit + reserved are backed by tokens held by this ledger.
    // Deployed is an informational record of value handed to an execution adapter.
    mapping(address => uint256) public custodyLiability;

    address public settlementAdapter;
    address public executionAdapter;
    uint256 public executionNonce;

    mapping(bytes32 => OutboundTransfer) public outboundTransfers;
    mapping(bytes32 => bool) public processedInboundTransfers;
    mapping(bytes32 => Execution) public executions;

    event AssetSupportUpdated(address indexed asset, bool supported);
    event SettlementAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);
    event ExecutionAdapterUpdated(address indexed previousAdapter, address indexed newAdapter);

    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, address indexed recipient, uint256 amount);

    event OutboundTransferStarted(
        bytes32 indexed transferId,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 destinationChainId,
        address destinationAsset,
        address recipient
    );
    event OutboundTransferFinalized(bytes32 indexed transferId, address indexed adapter, uint256 amount);
    event OutboundTransferCancelled(bytes32 indexed transferId, address indexed user, uint256 amount);

    event InboundTransferCredited(
        bytes32 indexed transferId,
        address indexed user,
        address indexed asset,
        uint256 amount,
        uint256 sourceChainId
    );

    event ExecutionReserved(
        bytes32 indexed executionId,
        address indexed user,
        address indexed asset,
        uint256 amount,
        bytes32 strategyId
    );
    event ExecutionCompleted(bytes32 indexed executionId, address indexed adapter, uint256 amount);
    event ExecutionReleased(bytes32 indexed executionId, address indexed user, uint256 amount);

    modifier onlySettlementAdapter() {
        require(msg.sender == settlementAdapter && settlementAdapter != address(0), "Not settlement adapter");
        _;
    }

    modifier onlyExecutionAdapter() {
        require(msg.sender == executionAdapter && executionAdapter != address(0), "Not execution adapter");
        _;
    }

    constructor(address initialOwner) Ownable(initialOwner) {
        require(initialOwner != address(0), "Invalid owner");
    }

    function setAssetSupport(address asset, bool supported) external onlyOwner {
        require(asset != address(0), "Invalid asset");
        supportedAssets[asset] = supported;
        emit AssetSupportUpdated(asset, supported);
    }

    function setSettlementAdapter(address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        emit SettlementAdapterUpdated(settlementAdapter, adapter);
        settlementAdapter = adapter;
    }

    function setExecutionAdapter(address adapter) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        emit ExecutionAdapterUpdated(executionAdapter, adapter);
        executionAdapter = adapter;
    }

    function getBalance(address user, address asset) external view returns (
        uint256 available,
        uint256 inTransit,
        uint256 reserved,
        uint256 deployed
    ) {
        Balance storage b = balances[user][asset];
        return (b.available, b.inTransit, b.reserved, b.deployed);
    }

    function deposit(address asset, uint256 amount)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 received)
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

    function withdraw(address asset, uint256 amount, address recipient)
        external
        nonReentrant
    {
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
        bytes32 transferId,
        address asset,
        uint256 amount,
        uint256 destinationChainId,
        address destinationAsset,
        address recipient
    ) external whenNotPaused {
        require(transferId != bytes32(0), "Invalid transfer ID");
        require(outboundTransfers[transferId].status == TransferStatus.None, "Transfer ID used");
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination chain");
        require(destinationAsset != address(0) && recipient != address(0), "Invalid destination");

        Balance storage b = balances[msg.sender][asset];
        require(b.available >= amount, "Insufficient available balance");

        b.available -= amount;
        b.inTransit += amount;

        outboundTransfers[transferId] = OutboundTransfer({
            user: msg.sender,
            asset: asset,
            destinationAsset: destinationAsset,
            recipient: recipient,
            amount: amount,
            destinationChainId: destinationChainId,
            status: TransferStatus.InTransit
        });

        emit OutboundTransferStarted(
            transferId,
            msg.sender,
            asset,
            amount,
            destinationChainId,
            destinationAsset,
            recipient
        );
    }

    /**
     * @notice Called by the settlement adapter in the same transaction in
     *         which it submits the underlying bridge burn/transfer.
     *         If the adapter's bridge call reverts, this state change and token
     *         transfer revert atomically as well.
     */
    function finalizeOutboundTransfer(bytes32 transferId)
        external
        onlySettlementAdapter
        nonReentrant
    {
        OutboundTransfer storage transfer = outboundTransfers[transferId];
        require(transfer.status == TransferStatus.InTransit, "Transfer not in transit");

        transfer.status = TransferStatus.Finalized;
        balances[transfer.user][transfer.asset].inTransit -= transfer.amount;
        custodyLiability[transfer.asset] -= transfer.amount;

        IERC20(transfer.asset).safeTransfer(msg.sender, transfer.amount);
        emit OutboundTransferFinalized(transferId, msg.sender, transfer.amount);
    }

    function cancelOutboundTransfer(bytes32 transferId) external onlySettlementAdapter {
        OutboundTransfer storage transfer = outboundTransfers[transferId];
        require(transfer.status == TransferStatus.InTransit, "Transfer not in transit");

        transfer.status = TransferStatus.Cancelled;
        Balance storage b = balances[transfer.user][transfer.asset];
        b.inTransit -= transfer.amount;
        b.available += transfer.amount;

        emit OutboundTransferCancelled(transferId, transfer.user, transfer.amount);
    }

    /**
     * @notice The adapter must first transfer the verified destination tokens
     *         into this contract, then call this function in the same tx.
     *         A transfer ID can only ever be credited once.
     */
    function creditInboundTransfer(
        bytes32 transferId,
        address user,
        address asset,
        uint256 amount,
        uint256 sourceChainId
    ) external onlySettlementAdapter whenNotPaused {
        require(transferId != bytes32(0), "Invalid transfer ID");
        require(!processedInboundTransfers[transferId], "Transfer already credited");
        require(user != address(0), "Invalid user");
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(sourceChainId != 0 && sourceChainId != block.chainid, "Invalid source chain");

        // Ensure the inbound tokens are actually present before creating a claim.
        require(
            IERC20(asset).balanceOf(address(this)) >= custodyLiability[asset] + amount,
            "Inbound funds not received"
        );

        processedInboundTransfers[transferId] = true;
        balances[user][asset].available += amount;
        custodyLiability[asset] += amount;

        emit InboundTransferCredited(transferId, user, asset, amount, sourceChainId);
    }

    function reserveExecution(address asset, uint256 amount, bytes32 strategyId)
        external
        whenNotPaused
        returns (bytes32 executionId)
    {
        require(supportedAssets[asset], "Asset not supported");
        require(amount != 0, "Amount is zero");
        require(strategyId != bytes32(0), "Invalid strategy");

        Balance storage b = balances[msg.sender][asset];
        require(b.available >= amount, "Insufficient available balance");

        executionId = keccak256(
            abi.encode(block.chainid, address(this), msg.sender, executionNonce++)
        );

        b.available -= amount;
        b.reserved += amount;

        executions[executionId] = Execution({
            user: msg.sender,
            asset: asset,
            amount: amount,
            strategyId: strategyId,
            status: ExecutionStatus.Reserved
        });

        emit ExecutionReserved(executionId, msg.sender, asset, amount, strategyId);
    }

    /**
     * @notice Hands the reserved input tokens to the approved execution
     *         adapter. The adapter must perform the user-authorized strategy.
     *         The deployed bucket is an accounting record, not a redeemable
     *         token balance; external positions are tracked separately.
     */
    function completeExecution(bytes32 executionId)
        external
        onlyExecutionAdapter
        nonReentrant
    {
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
        require(
            msg.sender == execution.user || msg.sender == executionAdapter,
            "Not authorized to release"
        );

        execution.status = ExecutionStatus.Released;
        Balance storage b = balances[execution.user][execution.asset];
        b.reserved -= execution.amount;
        b.available += execution.amount;

        emit ExecutionReleased(executionId, execution.user, execution.amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
