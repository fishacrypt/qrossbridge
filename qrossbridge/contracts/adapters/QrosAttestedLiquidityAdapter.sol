// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./QrosSettlementAdapterBase.sol";

/// @notice Quorum-attested, prefunded-liquidity settlement adapter.
/// @dev This is a concrete reference integration, NOT a trustless bridge:
///      validators attest source dispatch/delivery while destination liquidity
///      is released from inventory pre-funded on the destination chain.
contract QrosAttestedLiquidityAdapter is QrosSettlementAdapterBase {
    using SafeERC20 for IERC20;

    struct EscrowedTransfer {
        address asset;
        uint256 amount;
        uint256 destinationChainId;
        address destinationAsset;
        address recipient;
    }

    mapping(bytes32 => EscrowedTransfer) public escrowed;
    mapping(bytes32 => bool) public outboundRouteEnabled;

    event OutboundLiquidityLocked(
        bytes32 indexed transferId, address indexed sourceAsset, uint256 amount,
        uint256 destinationChainId, address destinationAsset, address recipient
    );
    event DestinationLiquidityReleased(bytes32 indexed transferId, address indexed asset, uint256 amount);
    event SourceLiquidityRefunded(bytes32 indexed transferId, address indexed asset, uint256 amount);
    event OutboundRouteUpdated(bytes32 indexed routeId, bool enabled);

    constructor(address initialOwner, address ledger_, address verifier_, address coordinator_)
        QrosSettlementAdapterBase(initialOwner, ledger_, verifier_, coordinator_) {}

    function routeId(address sourceAsset, uint256 destinationChainId, address destinationAsset)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(sourceAsset, destinationChainId, destinationAsset));
    }

    function setOutboundRoute(address sourceAsset, uint256 destinationChainId, address destinationAsset, bool enabled)
        external onlyOwner
    {
        require(sourceAsset != address(0) && destinationAsset != address(0), "Zero asset");
        require(destinationChainId != 0 && destinationChainId != block.chainid, "Invalid destination");
        bytes32 id = routeId(sourceAsset, destinationChainId, destinationAsset);
        outboundRouteEnabled[id] = enabled;
        emit OutboundRouteUpdated(id, enabled);
    }

    function _dispatchOutbound(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address recipient
    ) internal override {
        require(outboundRouteEnabled[routeId(asset, destinationChainId, destinationAsset)], "Route disabled");
        require(escrowed[transferId].asset == address(0), "Transfer already escrowed");
        require(IERC20(asset).balanceOf(address(this)) >= amount, "Source escrow not received");
        escrowed[transferId] = EscrowedTransfer(asset, amount, destinationChainId, destinationAsset, recipient);
        emit OutboundLiquidityLocked(transferId, asset, amount, destinationChainId, destinationAsset, recipient);
    }

    /// @dev Releases pre-funded destination inventory after quorum attestation.
    function _releaseInbound(address asset, uint256 amount) internal override {
        require(IERC20(asset).balanceOf(address(this)) >= amount, "Destination liquidity unavailable");
        IERC20(asset).safeTransfer(address(ledger), amount);
    }

    function _verifyPreDispatchCancellation(bytes32 transferId, bytes calldata data)
        internal view override returns (bool)
    {
        return verifier.verifyCancellation(transferId, data);
    }

    /// @dev Returns exactly the source asset/amount committed to this transfer.
    function _returnRecoveredAsset(address asset, bytes32 transferId, bytes calldata)
        internal override
    {
        EscrowedTransfer memory item = escrowed[transferId];
        require(item.asset == asset && item.amount != 0, "Escrow record mismatch");
        delete escrowed[transferId];
        IERC20(asset).safeTransfer(address(ledger), item.amount);
        emit SourceLiquidityRefunded(transferId, asset, item.amount);
    }

    /// @notice Anyone may top up destination liquidity inventory.
    function fundLiquidity(address asset, uint256 amount) external {
        require(asset != address(0) && amount != 0, "Invalid funding");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }

    function liquidityBalance(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }
}
