// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice A chain/protocol-specific verifier must authenticate finality and bind
/// every returned field to the same transfer ID. It must not trust relayer claims.
interface IQrosSettlementProofVerifier {
    function verifyDelivery(bytes32 transferId, bytes calldata proof)
        external view
        returns (bool valid, uint256 sourceChainId, address recipient, address destinationAsset, uint256 amount);

    function verifyRecovery(bytes32 transferId, bytes calldata proof)
        external view returns (bool valid, uint256 sourceChainId, address sourceAsset, uint256 amount);

    function verifyCancellation(bytes32 transferId, bytes calldata proof)
        external view returns (bool valid);
}
