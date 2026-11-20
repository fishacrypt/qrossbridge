// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "../interfaces/IQrosSettlementProofVerifier.sol";

/// @notice Threshold EIP-712 attestations for the existing QROS hub-and-spoke bridge.
/// @dev This is an explicit validator trust model, NOT a trustless light client.
///      Validators must independently reconcile source and destination chain events.
contract QrosQuorumAttestationVerifier is Ownable, IQrosSettlementProofVerifier {
    using ECDSA for bytes32;

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("QROS Quorum Settlement Attestation");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant DELIVERY_TYPEHASH = keccak256(
        "Delivery(bytes32 transferId,uint256 sourceChainId,uint256 destinationChainId,address recipient,address destinationAsset,uint256 amount,uint256 deadline)"
    );
    bytes32 private constant RECOVERY_TYPEHASH = keccak256(
        "Recovery(bytes32 transferId,uint256 sourceChainId,address sourceAsset,uint256 amount,uint256 deadline)"
    );

    mapping(address => bool) public isSigner;
    mapping(bytes32 => bool) public enabledRoute;
    uint256 public signerCount;
    uint256 public threshold;

    event SignerUpdated(address indexed signer, bool enabled);
    event ThresholdUpdated(uint256 threshold);
    event RouteUpdated(uint256 indexed sourceChainId, uint256 indexed destinationChainId, address indexed destinationAsset, bool enabled);

    constructor(address initialOwner, uint256 threshold_) Ownable(initialOwner) {
        require(initialOwner != address(0) && threshold_ != 0, "Invalid config");
        threshold = threshold_;
    }

    function setSigner(address signer, bool enabled) external onlyOwner {
        require(signer != address(0), "Zero signer");
        if (isSigner[signer] == enabled) return;
        isSigner[signer] = enabled;
        if (enabled) signerCount++;
        else signerCount--;
        require(threshold <= signerCount, "Threshold exceeds signer count");
        emit SignerUpdated(signer, enabled);
    }

    function setThreshold(uint256 next) external onlyOwner {
        require(next != 0 && next <= signerCount, "Invalid threshold");
        threshold = next;
        emit ThresholdUpdated(next);
    }

    function setRoute(uint256 sourceChainId, uint256 destinationChainId, address destinationAsset, bool enabled)
        external onlyOwner
    {
        require(sourceChainId != 0 && destinationChainId != 0 && sourceChainId != destinationChainId, "Invalid chains");
        require(destinationAsset != address(0), "Zero asset");
        enabledRoute[routeKey(sourceChainId, destinationChainId, destinationAsset)] = enabled;
        emit RouteUpdated(sourceChainId, destinationChainId, destinationAsset, enabled);
    }

    function routeKey(uint256 sourceChainId, uint256 destinationChainId, address destinationAsset)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(sourceChainId, destinationChainId, destinationAsset));
    }

    function verifyDelivery(bytes32 transferId, bytes calldata proof)
        external view returns (
            bool valid, uint256 sourceChainId, address recipient, address destinationAsset, uint256 amount
        )
    {
        uint256 destinationChainId;
        uint256 deadline;
        bytes[] memory signatures;
        (sourceChainId, destinationChainId, recipient, destinationAsset, amount, deadline, signatures) =
            abi.decode(proof, (uint256,uint256,address,address,uint256,uint256,bytes[]));

        if (
            transferId == bytes32(0) || sourceChainId == 0 ||
            destinationChainId != block.chainid || sourceChainId == destinationChainId ||
            recipient == address(0) || destinationAsset == address(0) || amount == 0 ||
            block.timestamp > deadline ||
            !enabledRoute[routeKey(sourceChainId, destinationChainId, destinationAsset)]
        ) return (false, sourceChainId, recipient, destinationAsset, amount);

        bytes32 structHash = keccak256(abi.encode(
            DELIVERY_TYPEHASH, transferId, sourceChainId, destinationChainId,
            recipient, destinationAsset, amount, deadline
        ));
        valid = _hasQuorum(_digest(structHash), signatures);
    }

    function verifyRecovery(bytes32 transferId, bytes calldata proof) external view returns (bool) {
        (uint256 sourceChainId, address sourceAsset, uint256 amount, uint256 deadline, bytes[] memory signatures) =
            abi.decode(proof, (uint256,address,uint256,uint256,bytes[]));
        if (
            transferId == bytes32(0) || sourceChainId != block.chainid ||
            sourceAsset == address(0) || amount == 0 || block.timestamp > deadline
        ) return false;
        bytes32 structHash = keccak256(abi.encode(
            RECOVERY_TYPEHASH, transferId, sourceChainId, sourceAsset, amount, deadline
        ));
        return _hasQuorum(_digest(structHash), signatures);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
        ));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _hasQuorum(bytes32 digest, bytes[] memory signatures) private view returns (bool) {
        if (signatures.length < threshold || signatures.length > signerCount) return false;
        address previous;
        uint256 validCount;
        for (uint256 i; i < signatures.length; ++i) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signatures[i]);
            if (err != ECDSA.RecoverError.NoError || !isSigner[recovered] || recovered <= previous) return false;
            previous = recovered;
            validCount++;
        }
        return validCount >= threshold;
    }
}
