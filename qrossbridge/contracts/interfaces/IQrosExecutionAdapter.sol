// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IQrosExecutionAdapter {
    /// @return spent Amount of the ledger's input asset consumed by execution.
    /// @return returnedAmount Unspent input asset returned to the ledger.
    /// @return positionId Adapter-defined identifier; zero when no position is created.
    function execute(
        bytes32 executionId,
        address user,
        address asset,
        uint256 amount,
        bytes32 strategyId,
        bytes calldata adapterData
    ) external returns (uint256 spent, uint256 returnedAmount, bytes32 positionId);
}