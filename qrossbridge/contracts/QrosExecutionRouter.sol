// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IQrosExecutionLedger {
    function reserveExecutionFor(address user, address asset, uint256 amount, bytes32 strategyId) external returns (bytes32);
    function executeReserved(bytes32 executionId, bytes calldata adapterData) external returns (bytes32);
    function releaseExecutionForRouter(bytes32 executionId) external;
}

/// @notice User-signed, parameter-bound execution authorization.
/// @dev The signature binds chain, ledger, asset, amount, strategy, adapter data,
///      nonce and deadline. The ledger executes adapter calls atomically.
contract QrosExecutionRouter is Ownable, EIP712, ReentrancyGuard {
    bytes32 private constant INTENT_TYPEHASH = keccak256("ExecutionIntent(address user,address asset,uint256 amount,bytes32 strategyId,bytes32 adapterDataHash,uint256 nonce,uint256 deadline)");
    struct ExecutionIntent {
        address user;
        address asset;
        uint256 amount;
        bytes32 strategyId;
        bytes32 adapterDataHash;
        uint256 nonce;
        uint256 deadline;
    }

    IQrosExecutionLedger public immutable ledger;
    mapping(bytes32 => bool) public approvedStrategies;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public consumedIntent;
    mapping(bytes32 => bytes32) public executionForIntent;

    event StrategyApproval(bytes32 indexed strategyId, bool approved);
    event IntentExecuted(bytes32 indexed intentHash, bytes32 indexed executionId, address indexed user, bytes32 positionId);
    event IntentCancelled(bytes32 indexed intentHash, bytes32 indexed executionId);

    constructor(address initialOwner, address ledger_) Ownable(initialOwner) EIP712("QROS Execution Router", "1") {
        require(ledger_ != address(0), "Invalid ledger");
        ledger = IQrosExecutionLedger(ledger_);
    }

    function setStrategy(bytes32 strategyId, bool approved) external onlyOwner {
        require(strategyId != bytes32(0), "Invalid strategy");
        approvedStrategies[strategyId] = approved;
        emit StrategyApproval(strategyId, approved);
    }

    function hashIntent(ExecutionIntent calldata i) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            INTENT_TYPEHASH, i.user, i.asset, i.amount, i.strategyId,
            i.adapterDataHash, i.nonce, i.deadline
        ));
        return _hashTypedDataV4(structHash);
    }

    function execute(ExecutionIntent calldata i, bytes calldata adapterData, bytes calldata signature)
        external nonReentrant returns (bytes32 executionId, bytes32 positionId)
    {
        require(i.user != address(0) && i.asset != address(0) && i.amount != 0, "Invalid intent");
        require(block.timestamp <= i.deadline, "Intent expired");
        require(i.nonce == nonces[i.user], "Invalid nonce");
        require(approvedStrategies[i.strategyId], "Strategy not approved");
        require(keccak256(adapterData) == i.adapterDataHash, "Adapter data mismatch");
        bytes32 intentHash = hashIntent(i);
        require(!consumedIntent[intentHash], "Intent already consumed");
        require(ECDSA.recover(intentHash, signature) == i.user, "Invalid user signature");

        consumedIntent[intentHash] = true;
        nonces[i.user] = i.nonce + 1;
        executionId = ledger.reserveExecutionFor(i.user, i.asset, i.amount, i.strategyId);
        executionForIntent[intentHash] = executionId;
        positionId = ledger.executeReserved(executionId, adapterData);
        emit IntentExecuted(intentHash, executionId, i.user, positionId);
    }

    function cancelExpired(bytes32 intentHash, bytes32 executionId) external nonReentrant {
        require(executionForIntent[intentHash] == executionId && executionId != bytes32(0), "Unknown intent");
        // Only reserved executions can be released; completed executions revert in the ledger.
        ledger.releaseExecutionForRouter(executionId);
        emit IntentCancelled(intentHash, executionId);
    }
}