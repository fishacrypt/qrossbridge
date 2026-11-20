// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./QrosSettlementAdapterBase.sol";
import "../interfaces/IQrosQmsBridgeProofVerifier.sol";

interface IQmsHubGateway {
    function depositWQMS(uint256 amount, uint256 dstChainId, address recipient) external;
}
interface IQmsSpokeGateway {
    function bridgeBackFor(address holder, uint256 amount, address recipient, bool asNative) external;
    function token() external view returns (address);
}
interface IWQMSGateway {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Gateway adapter for the existing QMS Hub <-> remote wQMS Spoke bridge.
/// @dev Requires independent quorum attestations of the source Bridged event AND destination processed/minted/released state.
///      This is a trusted-validator integration, not a trustless cross-chain light client.
contract QrosQmsBridgeAdapter is QrosSettlementAdapterBase {
    using SafeERC20 for IERC20;

    struct RemoteRoute {
        address bridge;
        address token;
        address adapter;
        bool enabled;
    }

    uint256 public immutable hubChainId;
    address public immutable hubBridge;
    address public immutable hubWQMS;
    IQrosQmsBridgeProofVerifier public bridgeVerifier;
    mapping(uint256 => RemoteRoute) public remoteRoutes;
    mapping(bytes32 => bool) public outboundMessageUsed;

    event RemoteRouteUpdated(uint256 indexed chainId, address bridge, address token, address adapter, bool enabled);
    event BridgeVerifierUpdated(address indexed verifier);
    event QmsBridgeDispatch(bytes32 indexed transferId, uint256 indexed destinationChainId, bytes32 bridgeMessageId, address indexed destinationAdapter, uint256 amount);
    event QmsBridgeInbound(bytes32 indexed transferId, bytes32 indexed bridgeMessageId, address indexed beneficiary, address asset, uint256 amount);

    constructor(
        address initialOwner,
        address ledger_,
        address settlementVerifier_,
        address coordinator_,
        address bridgeVerifier_,
        uint256 hubChainId_,
        address hubBridge_,
        address hubWQMS_
    ) QrosSettlementAdapterBase(initialOwner, ledger_, settlementVerifier_, coordinator_) {
        require(
            bridgeVerifier_ != address(0) && hubChainId_ != 0 &&
            hubBridge_ != address(0) && hubWQMS_ != address(0),
            "Invalid QMS bridge config"
        );
        bridgeVerifier = IQrosQmsBridgeProofVerifier(bridgeVerifier_);
        hubChainId = hubChainId_;
        hubBridge = hubBridge_;
        hubWQMS = hubWQMS_;
    }

    function setBridgeVerifier(address next) external onlyOwner {
        require(next != address(0), "Zero verifier");
        bridgeVerifier = IQrosQmsBridgeProofVerifier(next);
        emit BridgeVerifierUpdated(next);
    }

    /// @notice Configure the remote Hub/Spoke endpoint, its wrapped token and destination Gateway adapter.
    function setRemoteRoute(
        uint256 chainId, address bridge, address token, address adapter, bool enabled
    ) external onlyOwner {
        require(chainId != 0 && chainId != block.chainid, "Invalid chain");
        require(bridge != address(0) && token != address(0) && adapter != address(0), "Zero route field");
        remoteRoutes[chainId] = RemoteRoute(bridge, token, adapter, enabled);
        emit RemoteRouteUpdated(chainId, bridge, token, adapter, enabled);
    }

    function _dispatchOutbound(
        bytes32 transferId, address asset, uint256 amount, uint256 destinationChainId,
        address destinationAsset, address, address, address
    ) internal override {
        RemoteRoute memory route = remoteRoutes[destinationChainId];
        require(route.enabled, "QMS route disabled");
        require(destinationAsset == route.token, "Destination wQMS mismatch");
        require(!outboundMessageUsed[transferId], "Bridge transfer already used");
        outboundMessageUsed[transferId] = true;

        bytes32 bridgeMessageId;
        if (block.chainid == hubChainId) {
            require(asset == hubWQMS, "Source asset is not hub wQMS");
            uint256 nonceBefore = _hubNonce();
            IERC20(asset).forceApprove(hubBridge, amount);
            IQmsHubGateway(hubBridge).depositWQMS(amount, destinationChainId, route.adapter);
            bridgeMessageId = keccak256(abi.encode(block.chainid, nonceBefore + 1));
        } else {
            require(asset == IQmsSpokeGateway(addressFromBridge()).token(), "Source asset is not local spoke wQMS");
            uint256 nonceBefore = _spokeNonce();
            IQmsSpokeGateway(addressFromBridge()).bridgeBackFor(address(this), amount, route.adapter, false);
            bridgeMessageId = keccak256(abi.encode(block.chainid, nonceBefore + 1));
        }
        emit QmsBridgeDispatch(transferId, destinationChainId, bridgeMessageId, route.adapter, amount);
    }

    function _releaseInbound(address asset, uint256 amount) internal override {
        require(IERC20(asset).balanceOf(address(this)) >= amount, "wQMS not delivered to adapter");
        IERC20(asset).safeTransfer(address(ledger), amount);
    }

    function _deliveryProof(bytes calldata proof) internal pure override returns (bytes memory settlementProof) {
        (settlementProof,) = abi.decode(proof, (bytes, bytes));
    }

    function _verifyInboundBridgeProof(
        bytes32 transferId, bytes calldata proof, uint256 sourceChainId,
        address recipient, address asset, uint256 amount
    ) internal view override returns (bool) {
        (, bytes memory bridgeProof) = abi.decode(proof, (bytes, bytes));
        (
            bool valid,
            uint256 provedSourceChain,
            uint256 destinationChain,
            address sourceBridge,
            address destinationBridge,
            address sourceToken,
            address destinationToken,
            address destinationAdapter,
            address beneficiary,
            uint256 provedAmount,
            bytes32 bridgeMessageId
        ) = bridgeVerifier.verifyBridgeDelivery(transferId, bridgeProof);

        RemoteRoute memory sourceRoute = remoteRoutes[sourceChainId];
        address expectedSourceBridge = sourceChainId == hubChainId ? hubBridge : sourceRoute.bridge;
        address expectedSourceToken = sourceChainId == hubChainId ? hubWQMS : sourceRoute.token;
        address expectedDestinationBridge = block.chainid == hubChainId ? hubBridge : _localSpokeBridge();
        address expectedDestinationToken = block.chainid == hubChainId ? hubWQMS : _localSpokeToken();

        return valid && provedSourceChain == sourceChainId && destinationChain == block.chainid &&
            sourceBridge == expectedSourceBridge && destinationBridge == expectedDestinationBridge &&
            sourceToken == expectedSourceToken && destinationToken == asset &&
            expectedDestinationToken == asset && destinationAdapter == address(this) &&
            beneficiary == recipient && provedAmount == amount && bridgeMessageId != bytes32(0);
    }

    function _verifyPreDispatchCancellation(bytes32 transferId, bytes calldata data)
        internal view override returns (bool)
    {
        return verifier.verifyCancellation(transferId, data);
    }

    function _returnRecoveredAsset(address asset, bytes32 transferId, bytes calldata)
        internal override
    {
        // The bridge adapter cannot fabricate a refund. The exact wQMS must have been returned
        // by the Hub/Spoke recovery path before the Gateway ledger restores the liability.
        (address user, address recordedAsset,,,,,uint8 status) = ledger.outboundTransfers(transferId);
        require(user != address(0) && recordedAsset == asset && status == 2, "Recovery intent mismatch");
        require(IERC20(asset).balanceOf(address(this)) >= _outboundAmount(transferId), "Recovered wQMS not received");
        IERC20(asset).safeTransfer(address(ledger), _outboundAmount(transferId));
        emit SourceLiquidityRefunded(transferId, asset, _outboundAmount(transferId));
    }

    function _outboundAmount(bytes32 transferId) private view returns (uint256 amount) {
        (,,,,amount,,) = ledger.outboundTransfers(transferId);
    }

    function _hubNonce() private view returns (uint256 value) {
        (bool ok, bytes memory data) = hubBridge.staticcall(abi.encodeWithSignature("nonce()"));
        require(ok && data.length >= 32, "Hub nonce unavailable");
        value = abi.decode(data, (uint256));
    }

    function _spokeNonce() private view returns (uint256 value) {
        (bool ok, bytes memory data) = _localSpokeBridge().staticcall(abi.encodeWithSignature("nonce()"));
        require(ok && data.length >= 32, "Spoke nonce unavailable");
        value = abi.decode(data, (uint256));
    }

    function _localSpokeBridge() private view returns (address) {
        return addressFromBridge();
    }

    function _localSpokeToken() private view returns (address) {
        return IQmsSpokeGateway(addressFromBridge()).token();
    }

    function addressFromBridge() internal view returns (address) {
        // For a spoke-side adapter, the local spoke endpoint is configured under its own chain ID.
        RemoteRoute memory route = remoteRoutes[block.chainid];
        require(route.bridge != address(0), "Local spoke bridge not configured");
        return route.bridge;
    }

    function fundAdapterToken(address asset, uint256 amount) external {
        require(asset != address(0) && amount != 0, "Invalid funding");
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    }
}
