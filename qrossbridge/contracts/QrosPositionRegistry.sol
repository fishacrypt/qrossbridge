// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/access/Ownable.sol";

contract QrosPositionRegistry is Ownable {
    enum Status { None, Active, Closing, Closed }
    struct Position {
        address user; uint256 chainId; address positionManager; uint256 tokenId;
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint128 liquidity; Status status; uint64 createdAt;
    }
    mapping(bytes32 => Position) private positions;
    mapping(address => bool) public approvedAdapters;
    mapping(address => bytes32[]) private userPositions;
    event AdapterApproval(address indexed adapter, bool approved);
    event PositionRegistered(bytes32 indexed positionId, address indexed user, address indexed positionManager, uint256 tokenId);
    event PositionStatusChanged(bytes32 indexed positionId, Status status, uint128 liquidity);
    constructor(address initialOwner) Ownable(initialOwner) {}
    function setAdapter(address adapter, bool approved) external onlyOwner {
        require(adapter != address(0), "Invalid adapter"); approvedAdapters[adapter] = approved; emit AdapterApproval(adapter, approved);
    }
    function registerPosition(bytes32 positionId, address user, address manager, uint256 tokenId, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        require(approvedAdapters[msg.sender], "Adapter not approved");
        require(positionId != bytes32(0) && positions[positionId].status == Status.None, "Position ID used");
        require(user != address(0) && manager != address(0) && token0 != address(0) && token1 != address(0), "Invalid position");
        require(token0 < token1 && tickLower < tickUpper && liquidity != 0, "Invalid pool position");
        positions[positionId] = Position(user, block.chainid, manager, tokenId, token0, token1, fee, tickLower, tickUpper, liquidity, Status.Active, uint64(block.timestamp));
        userPositions[user].push(positionId); emit PositionRegistered(positionId, user, manager, tokenId);
    }
    function updatePosition(bytes32 positionId, Status status, uint128 liquidity) external {
        require(approvedAdapters[msg.sender], "Adapter not approved");
        Position storage p = positions[positionId];
        require(p.status == Status.Active || p.status == Status.Closing, "Position unavailable");
        require(status == Status.Active || status == Status.Closing || status == Status.Closed, "Invalid status");
        if (status == Status.Closed) require(liquidity == 0, "Closed position has liquidity");
        p.status = status; p.liquidity = liquidity; emit PositionStatusChanged(positionId, status, liquidity);
    }
    function getPosition(bytes32 positionId) external view returns (Position memory) { return positions[positionId]; }
    function getUserPositions(address user) external view returns (bytes32[] memory) { return userPositions[user]; }
}