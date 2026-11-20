// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Chain-specific adapters implement these calls. Implementations must
///         verify source/destination settlement evidence, finality and replay
///         protection before calling the Gateway ledger.
interface IQrosSettlementAdapter {
    function initiate(bytes32 transferId) external;
    function proveAndFinalize(bytes32 transferId, bytes calldata proof) external;
    function cancelOrRecover(bytes32 transferId, bytes calldata recoveryData) external;
}