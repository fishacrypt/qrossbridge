// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Validator attestation over a specific QMS Hub/Spoke bridge event and its destination processing.
interface IQrosQmsBridgeProofVerifier {
    function verifyBridgeDelivery(bytes32 transferId, bytes calldata proof) external view returns (
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
    );
}
