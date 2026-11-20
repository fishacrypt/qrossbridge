// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IQrosTransferLedger {
    function beginOutboundTransferFor(address user, bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId, address destinationAsset, address recipient) external;
}
interface IQrosSettlementInitiator {
    function initiate(bytes32 transferId) external;
}

/// @notice Coordinates user transfer intents and delegates chain settlement.
/// @dev It does not prove messages itself; only a configured settlement adapter
///      may finalize or cancel the ledger transfer after independent verification.
contract QrosTransferCoordinator is Ownable, ReentrancyGuard {
    struct TransferIntent {
        address user;
        address asset;
        uint256 amount;
        uint256 destinationChainId;
        address destinationAsset;
        address recipient;
        address adapter;
        bool initiated;
        bool gatewayHandoff;
    }

    IQrosTransferLedger public immutable ledger;
    mapping(address => bool) public approvedAdapters;
    mapping(bytes32 => TransferIntent) public transfers;

    event AdapterApproval(address indexed adapter, bool approved);
    event TransferRequested(bytes32 indexed transferId, address indexed user, address indexed asset, uint256 amount, uint256 destinationChainId, address adapter);
    event TransferInitiated(bytes32 indexed transferId, address indexed adapter);
    event GatewayHandoffRequested(bytes32 indexed transferId, address indexed user, uint256 indexed destinationChainId, address destinationLedger, address destinationAsset, uint256 amount);

    constructor(address initialOwner, address ledger_) Ownable(initialOwner) {
        require(ledger_ != address(0), "Invalid ledger");
        ledger = IQrosTransferLedger(ledger_);
    }

    function setAdapter(address adapter, bool approved) external onlyOwner {
        require(adapter != address(0), "Invalid adapter");
        approvedAdapters[adapter] = approved;
        emit AdapterApproval(adapter, approved);
    }

    function requestTransfer(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address recipient, address adapter
    ) external nonReentrant {
        require(transferId != bytes32(0) && transfers[transferId].user == address(0), "Transfer ID used");
        require(approvedAdapters[adapter], "Adapter not approved");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination");
        require(destinationAsset != address(0) && recipient != address(0) && amount != 0, "Invalid transfer");
        transfers[transferId] = TransferIntent(msg.sender, asset, amount, destinationChainId, destinationAsset, recipient, adapter, false, false);
        ledger.beginOutboundTransferFor(msg.sender, transferId, asset, amount, destinationChainId, destinationAsset, recipient);
        emit TransferRequested(transferId, msg.sender, asset, amount, destinationChainId, adapter);
    }

    /// @notice Reserve source Gateway funds for delivery into the user's
    ///         Gateway ledger on another chain. The settlement adapter must
    ///         deliver destinationAsset to destinationLedger, then prove that
    ///         receipt before the destination ledger credits the same user.
    function requestGatewayHandoff(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address destinationLedger, address adapter
    ) external nonReentrant {
        require(transferId != bytes32(0) && transfers[transferId].user == address(0), "Transfer ID used");
        require(approvedAdapters[adapter], "Adapter not approved");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination");
        require(destinationAsset != address(0) && destinationLedger != address(0) && amount != 0, "Invalid handoff");
        transfers[transferId] = TransferIntent(
            msg.sender, asset, amount, destinationChainId, destinationAsset,
            destinationLedger, adapter, false, true
        );
        ledger.beginOutboundTransferFor(
            msg.sender, transferId, asset, amount, destinationChainId, destinationAsset, destinationLedger
        );
        emit TransferRequested(transferId, msg.sender, asset, amount, destinationChainId, adapter);
        emit GatewayHandoffRequested(transferId, msg.sender, destinationChainId, destinationLedger, destinationAsset, amount);
    }

    function getTransfer(bytes32 transferId) external view returns (TransferIntent memory) {
        return transfers[transferId];
    }

    function initiate(bytes32 transferId) external nonReentrant {
        TransferIntent storage t = transfers[transferId];
        require(t.user != address(0) && !t.initiated, "Transfer unavailable");
        require(msg.sender == t.user, "Only transfer owner may initiate");
        require(approvedAdapters[t.adapter], "Adapter not approved");
        t.initiated = true;
        IQrosSettlementInitiator(t.adapter).initiate(transferId);
        emit TransferInitiated(transferId, t.adapter);
    }
}