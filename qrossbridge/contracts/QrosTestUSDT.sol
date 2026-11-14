// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title QROS Test USDT
 * @notice Test-only USDT representation for QROS development on Base Sepolia.
 * @dev Not issued by Tether and has no real-world value.
 */
contract QrosTestUSDT is ERC20, Ownable {
    uint8 private constant TOKEN_DECIMALS = 6;

    constructor(address initialOwner)
        ERC20("QROS Test USDT", "USDT")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return TOKEN_DECIMALS;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        _mint(to, amount);
    }
}
