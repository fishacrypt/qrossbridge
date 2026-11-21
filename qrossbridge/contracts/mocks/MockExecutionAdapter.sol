// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IQrosExecutionAdapter.sol";

/// @dev Test-only adapter: returns the full input amount to the Gateway ledger.
contract MockExecutionAdapter is IQrosExecutionAdapter {
    using SafeERC20 for IERC20;

    function execute(
        bytes32 executionId,
        address,
        address asset,
        uint256 amount,
        bytes32,
        bytes calldata
    ) external returns (uint256 spent, uint256 returnedAmount, bytes32 positionId) {
        IERC20(asset).safeTransfer(msg.sender, amount);
        return (0, amount, keccak256(abi.encode(executionId, "mock-position")));
    }
}
