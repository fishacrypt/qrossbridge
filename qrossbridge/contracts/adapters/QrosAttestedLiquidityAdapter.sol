// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./QrosSettlementAdapterBase.sol";

/// @notice Quorum-attested, prefunded-liquidity adapter.
/// @dev Explicit validator trust model. This is NOT a trustless bridge or CCTP implementation.
contract QrosAttestedLiquidityAdapter is QrosSettlementAdapterBase {
    using SafeERC20 for IERC20;

    struct EscrowedTransfer {
        address asset;
        uint256 amount;
        uint256 destinationChainId;
        address destinationAsset;
        address ledgerRecipient;
        address beneficiary;
        address destinationLedger;
    }

    mapping(bytes32 => EscrowedTransfer) public escrowed;
    mapping(bytes32 => bool) public outboundRouteEnabled;
    address public settlementTreasury;
    mapping(bytes32 => bool) public outboundSettled;

    event OutboundLiquidityLocked(
        bytes32 indexed transferId, address indexed sourceAsset, uint256 amount,
        uint256 destinationChainId, address destinationAsset, address destinationLedger,
        address beneficiary
    );
    event DestinationLiquidityReleased(bytes32 indexed transferId, address indexed asset, uint256 amount);
    event SourceLiquidityRefunded(bytes32 indexed transferId, address indexed asset, uint256 amount);
    event OutboundRouteUpdated(bytes32 indexed routeId, bool enabled);
    event SettlementTreasuryUpdated(address indexed treasury);
    event SourceEscrowSettled(bytes32 indexed transferId, address indexed treasury, address indexed asset, uint256 amount);

    constructor(address initialOwner, address ledger_, address verifier_, address coordinator_)
        QrosSettlementAdapterBase(initialOwner, ledger_, verifier_, coordinator_) {}

    function routeId(address sourceAsset, uint256 destinationChainId, address destinationAsset)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(sourceAsset, destinationChainId, destinationAsset));
    }

    function setSettlementTreasury(address treasury) external onlyOwner {
        require(treasury != address(0), "Zero treasury");
        settlementTreasury = treasury;
        emit SettlementTreasuryUpdated(treasury);
    }

    function settleOutbound(bytes32 transferId, bytes calldata proof) external nonReentrant {
        require(!outboundSettled[transferId], "Already settled");
        EscrowedTransfer memory item = escrowed[transferId];
        require(item.asset != address(0) && item.amount != 0, "Unknown escrow");
        (bool valid, uint256 destinationChainId, address sourceAsset, address destinationAsset,
         address recipient, uint256 amount) = verifier.verifyOutboundSettlement(transferId, proof);
        require(
            valid && destinationChainId == item.destinationChainId &&
            sourceAsset == item.asset && destinationAsset == item.destinationAsset &&
            recipient == item.beneficiary && amount == item.amount,
            "Settlement proof mismatch"
        );
        require(settlementTreasury != address(0), "Treasury not configured");
        outboundSettled[transferId] = true;
        delete escrowed[transferId];
        IERC20(item.asset).safeTransfer(settlementTreasury, item.amount);
        emit SourceEscrowSettled(transferId, settlementTreasury, item.asset, item.amount);
    }

    function setOutboundRoute(address sourceAsset, uint256 destinationChainId, address destinationAsset, bool enabled)
        external onlyOwner
    {
        require(sourceAsset != address(0) && destinationAsset != address(0), "Zero asset");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination");
        outboundRouteEnabled[routeId(sourceAsset, destinationChainId, destinationAsset)] = enabled;
        emit OutboundRouteUpdated(routeId(sourceAsset, destinationChainId, destinationAsset), enabled);
    }

    function _dispatchOutbound(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address ledgerRecipient, address beneficiary, address destinationLedger
    ) internal override {
        require(outboundRouteEnabled[routeId(asset, destinationChainId, destinationAsset)], "Route disabled");
        require(escrowed[transferId].asset == address(0), "Transfer already escrowed");
        require(IERC20(asset).balanceOf(address(this)) >= amount, "Source escrow not received");
        if (destinationLedger != address(0)) require(ledgerRecipient == destinationLedger, "Gateway recipient mismatch");
        escrowed[transferId] = EscrowedTransfer(
            asset, amount, destinationChainId, destinationAsset, ledgerRecipient, beneficiary, destinationLedger
        );
        emit OutboundLiquidityLocked(
            transferId, asset, amount, destinationChainId, destinationAsset, destinationLedger, beneficiary
        );
    }

    /// @dev Destination inventory is released only after a verifier-approved delivery attestation.
    function _releaseInbound(address asset, uint256 amount) internal override {
        require(IERC20(asset).balanceOf(address(this)) >= amount, "Destination liquidity unavailable");
        IERC20(asset).safeTransfer(address(ledger), amount);
    }

    function _verifyPreDispatchCancellation(bytes32 transferId, bytes calldata data)
        internal view override returns (bool)
    {
        return verifier.verifyCancellation(transferId, data);
    }

    function _returnRecoveredAsset(address asset, bytes32 transferId, bytes calldata)
        internal override
    {
        EscrowedTransfer memory item = escrowed[transferId];
        require(!outboundSettled[transferId] && item.asset == asset && item.amount != 0, "Escrow record mismatch");
        delete escrowed[transferId];
        IERC20(asset).safeTransfer(address(ledger), item.amount);
        emit SourceLiquidityRefunded(transferId, asset, item.amount);
    }

    function fundLiquidity(address asset, uint256 amount) external {
        require(asset != address(0) && amount != 0, "Invalid funding");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    function liquidityBalance(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
