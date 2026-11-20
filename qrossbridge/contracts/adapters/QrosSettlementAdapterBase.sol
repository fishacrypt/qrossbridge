// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IQrosSettlementAdapter.sol";
import "../interfaces/IQrosSettlementProofVerifier.sol";

interface IQrosSettlementLedger {
    function finalizeOutboundTransfer(bytes32 transferId) external;
    function cancelOutboundTransfer(bytes32 transferId) external;
    function recoverFinalizedOutboundTransfer(bytes32 transferId) external;
    function creditInboundTransfer(bytes32 transferId, address user, address asset, uint256 amount, uint256 sourceChainId) external;
    function outboundTransfers(bytes32 transferId) external view returns (
        address user, address asset, address destinationAsset, address recipient,
        uint256 amount, uint256 destinationChainId, uint8 status
    );
    function supportedAssets(address asset) external view returns (bool);
}

/// @notice Security boundary shared by chain-specific settlement adapters.
/// @dev This abstract base is NOT a bridge. A child must implement the real
///      protocol dispatch, inbound asset release and proof-bound recovery.
abstract contract QrosSettlementAdapterBase is Ownable, ReentrancyGuard, IQrosSettlementAdapter {
    using SafeERC20 for IERC20;

    IQrosSettlementLedger public immutable ledger;
    IQrosSettlementProofVerifier public verifier;
    address public coordinator;
    mapping(bytes32 => bool) public initiated;
    mapping(bytes32 => bool) public inboundProcessed;
    mapping(bytes32 => bool) public recoveryProcessed;

    event SettlementDispatched(bytes32 indexed transferId, address indexed asset, uint256 amount, uint256 destinationChainId);
    event InboundSettlementVerified(bytes32 indexed transferId, address indexed recipient, address indexed asset, uint256 amount, uint256 sourceChainId);
    event OutboundRecoveryVerified(bytes32 indexed transferId);
    event VerifierUpdated(address indexed verifier);
    event CoordinatorUpdated(address indexed coordinator);

    modifier onlyCoordinator() {
        require(msg.sender == coordinator && coordinator != address(0), "Not coordinator");
        _;
    }

    constructor(address initialOwner, address ledger_, address verifier_, address coordinator_)
        Ownable(initialOwner)
    {
        require(ledger_ != address(0) && verifier_ != address(0) && coordinator_ != address(0), "Zero config");
        ledger = IQrosSettlementLedger(ledger_);
        verifier = IQrosSettlementProofVerifier(verifier_);
        coordinator = coordinator_;
    }

    function setVerifier(address next) external onlyOwner {
        require(next != address(0), "Zero verifier");
        verifier = IQrosSettlementProofVerifier(next);
        emit VerifierUpdated(next);
    }

    function setCoordinator(address next) external onlyOwner {
        require(next != address(0), "Zero coordinator");
        coordinator = next;
        emit CoordinatorUpdated(next);
    }

    /// @dev Finalizes custody handoff and dispatches in one atomic transaction.
    ///      A dispatch revert rolls the ledger handoff back as well.
    function initiate(bytes32 transferId) external onlyCoordinator nonReentrant {
        require(!initiated[transferId], "Already initiated");
        (address user, address asset, address destinationAsset, address recipient,
         uint256 amount, uint256 destinationChainId, uint8 status) = ledger.outboundTransfers(transferId);
        require(user != address(0) && status == 1, "Transfer not in transit");
        initiated[transferId] = true;
        ledger.finalizeOutboundTransfer(transferId);
        _dispatchOutbound(transferId, asset, amount, destinationChainId, destinationAsset, recipient);
        emit SettlementDispatched(transferId, asset, amount, destinationChainId);
    }

    /// @notice Anyone may submit a proof; only the configured verifier decides validity.
    function proveAndFinalize(bytes32 transferId, bytes calldata proof) external nonReentrant {
        require(!inboundProcessed[transferId], "Already processed");
        (bool valid, uint256 sourceChainId, address sourceAsset, address recipient, address asset, uint256 amount) =
            verifier.verifyDelivery(transferId, proof);
        require(sourceAsset != address(0), "Invalid source asset");
        require(valid && sourceChainId != 0 && sourceChainId != block.chainid, "Invalid settlement proof");
        require(recipient != address(0) && amount != 0 && ledger.supportedAssets(asset), "Invalid delivery fields");
        inboundProcessed[transferId] = true;
        _releaseInbound(asset, amount);
        ledger.creditInboundTransfer(transferId, recipient, asset, amount, sourceChainId);
        emit InboundSettlementVerified(transferId, recipient, asset, amount, sourceChainId);
    }

    /// @notice Recovery is only valid with protocol-authenticated return evidence.
    ///         Child adapter must return the exact source asset to the ledger first.
    function cancelOrRecover(bytes32 transferId, bytes calldata recoveryData) external nonReentrant {
        require(!recoveryProcessed[transferId], "Recovery already processed");
        (address user, address asset,,,,,uint8 status) = ledger.outboundTransfers(transferId);
        require(user != address(0), "Unknown transfer");
        if (status == 1) {
            require(_verifyPreDispatchCancellation(transferId, recoveryData), "Cancellation not proven");
            recoveryProcessed[transferId] = true;
            ledger.cancelOutboundTransfer(transferId);
        } else if (status == 2) {
            (bool valid, uint256 sourceChainId, address sourceAsset, uint256 recoveredAmount) =
                verifier.verifyRecovery(transferId, recoveryData);
            require(
                valid && sourceChainId == block.chainid && sourceAsset == asset &&
                recoveredAmount == _outboundAmount(transferId),
                "Recovery proof mismatch"
            );
            recoveryProcessed[transferId] = true;
            _returnRecoveredAsset(asset, transferId, recoveryData);
            ledger.recoverFinalizedOutboundTransfer(transferId);
        } else {
            revert("Transfer not recoverable");
        }
        emit OutboundRecoveryVerified(transferId);
    }

    function _outboundAmount(bytes32 transferId) private view returns (uint256 amount) {
        (,,,,amount,,) = ledger.outboundTransfers(transferId);
    }

    /// @dev Must dispatch the exact transfer to the configured settlement protocol.
    function _dispatchOutbound(bytes32 transferId, address asset, uint256 amount,
        uint256 destinationChainId, address destinationAsset, address recipient) internal virtual;

    /// @dev Must deliver/mint exactly amount of asset to the ledger before return.
    function _releaseInbound(address asset, uint256 amount) internal virtual;

    /// @dev Must verify no irreversible source action has happened.
    function _verifyPreDispatchCancellation(bytes32 transferId, bytes calldata data)
        internal view virtual returns (bool);

    /// @dev Must return exactly the original source asset to the ledger.
    function _returnRecoveredAsset(address asset, bytes32 transferId, bytes calldata data) internal virtual;
}
