// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../interfaces/IQrosQmsBridgeProofVerifier.sol";

/// @notice Threshold attestations for finalized QMS Hub/Spoke bridge events.
/// @dev Validators must independently verify the source Bridged event AND destination processed/minted/released state.
///      This is a disclosed validator trust model, not an on-chain cross-chain light client.
contract QrosQmsBridgeAttestationVerifier is Ownable, IQrosQmsBridgeProofVerifier {
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("QROS QMS Bridge Attestation");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "QmsBridgeDelivery(bytes32 transferId,uint256 sourceChainId,uint256 destinationChainId,address sourceBridge,address destinationBridge,address sourceToken,address destinationToken,address destinationAdapter,address beneficiary,uint256 amount,bytes32 bridgeMessageId,uint256 deadline)"
    );

    mapping(address => bool) public isSigner;
    mapping(bytes32 => bool) public enabledRoute;
    uint256 public signerCount;
    uint256 public threshold;

    event SignerUpdated(address indexed signer, bool enabled);
    event ThresholdUpdated(uint256 threshold);
    event RouteUpdated(bytes32 indexed routeId, bool enabled);

    constructor(address initialOwner, uint256 threshold_) Ownable(initialOwner) {
        require(initialOwner != address(0) && threshold_ != 0, "Invalid config");
        threshold = threshold_;
    }

    function setSigner(address signer, bool enabled) external onlyOwner {
        require(signer != address(0), "Zero signer");
        if (isSigner[signer] == enabled) return;
        if (!enabled) require(signerCount > threshold, "Cannot remove signer at threshold");
        isSigner[signer] = enabled;
        if (enabled) signerCount++;
        else signerCount--;
        emit SignerUpdated(signer, enabled);
    }

    function setThreshold(uint256 next) external onlyOwner {
        require(next != 0 && next <= signerCount, "Invalid threshold");
        threshold = next;
        emit ThresholdUpdated(next);
    }

    function routeKey(
        uint256 sourceChainId, uint256 destinationChainId,
        address sourceBridge, address destinationBridge,
        address sourceToken, address destinationToken, address destinationAdapter
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(
            sourceChainId, destinationChainId, sourceBridge, destinationBridge,
            sourceToken, destinationToken, destinationAdapter
        ));
    }

    function setRoute(
        uint256 sourceChainId, uint256 destinationChainId,
        address sourceBridge, address destinationBridge,
        address sourceToken, address destinationToken, address destinationAdapter,
        bool enabled
    ) external onlyOwner {
        require(sourceChainId != 0 && destinationChainId != 0 && sourceChainId != destinationChainId, "Invalid chains");
        require(
            sourceBridge != address(0) && destinationBridge != address(0) &&
            sourceToken != address(0) && destinationToken != address(0) &&
            destinationAdapter != address(0), "Zero route field"
        );
        bytes32 key = routeKey(sourceChainId, destinationChainId, sourceBridge, destinationBridge, sourceToken, destinationToken, destinationAdapter);
        enabledRoute[key] = enabled;
        emit RouteUpdated(key, enabled);
    }

    function verifyBridgeDelivery(bytes32 transferId, bytes calldata proof) external view override returns (
        bool valid,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address sourceBridge,
        address destinationBridge,
        address sourceToken,
        address destinationToken,
        address destinationAdapter,
        address beneficiary,
        uint256 amount,
        bytes32 bridgeMessageId
    ) {
        uint256 deadline;
        bytes[] memory signatures;
        (
            sourceChainId, destinationChainId, sourceBridge, destinationBridge,
            sourceToken, destinationToken, destinationAdapter, beneficiary,
            amount, bridgeMessageId, deadline, signatures
        ) = abi.decode(proof, (uint256,uint256,address,address,address,address,address,address,uint256,bytes32,uint256,bytes[]));

        if (
            transferId == bytes32(0) || sourceChainId == 0 || destinationChainId != block.chainid ||
            sourceChainId == destinationChainId || sourceBridge == address(0) ||
            destinationBridge == address(0) || sourceToken == address(0) ||
            destinationToken == address(0) || destinationAdapter == address(0) ||
            beneficiary == address(0) || amount == 0 || bridgeMessageId == bytes32(0) ||
            block.timestamp > deadline ||
            !enabledRoute[routeKey(sourceChainId, destinationChainId, sourceBridge, destinationBridge, sourceToken, destinationToken, destinationAdapter)]
        ) return (
            false, sourceChainId, destinationChainId, sourceBridge, destinationBridge,
            sourceToken, destinationToken, destinationAdapter, beneficiary, amount, bridgeMessageId
        );

        bytes32 structHash = keccak256(abi.encode(
            DELIVERY_TYPEHASH, transferId, sourceChainId, destinationChainId,
            sourceBridge, destinationBridge, sourceToken, destinationToken,
            destinationAdapter, beneficiary, amount, bridgeMessageId, deadline
        ));
        valid = _hasQuorum(_digest(structHash), signatures);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _hasQuorum(bytes32 digest, bytes[] memory signatures) private view returns (bool) {
        if (signatures.length < threshold || signatures.length > signerCount) return false;
        address previous;
        for (uint256 i; i < signatures.length; ++i) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError || !isSigner[recovered] || recovered <= previous) return false;
            previous = recovered;
        }
        return true;
    }
}
