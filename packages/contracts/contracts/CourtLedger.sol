// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Append-only record for the Agent Dispute Court.
/// Sellers anchor Merkle roots of their delivery receipts; the court publishes rulings.
/// Leaves/nodes use MetalAssertions' CLAIM_MERKLE_LEAF hashing (0x00 leaf, 0x01 node).
contract CourtLedger {
    event DeliveriesCommitted(address indexed seller, uint256 indexed batch, bytes32 root, uint256 count, string uri);
    event Ruling(bytes32 indexed disputeId, bytes32 indexed paymentTx, uint8 verdict, uint256 refund, bytes32 evidenceRoot, string reasonCode);

    address public immutable court;
    mapping(address => uint256) public batches;
    mapping(address => mapping(uint256 => bytes32)) public rootOf;

    constructor(address court_) { court = court_; }

    function commit(bytes32 root, uint256 count, string calldata uri) external returns (uint256 batch) {
        batch = batches[msg.sender]++;
        rootOf[msg.sender][batch] = root;
        emit DeliveriesCommitted(msg.sender, batch, root, count, uri);
    }

    function rule(bytes32 disputeId, bytes32 paymentTx, uint8 verdict, uint256 refund, bytes32 evidenceRoot, string calldata reasonCode) external {
        require(msg.sender == court, "court only");
        emit Ruling(disputeId, paymentTx, verdict, refund, evidenceRoot, reasonCode);
    }

    /// Anyone can check that a delivery receipt was committed before the dispute.
    function proves(address seller, uint256 batch, uint256 index, bytes32 leaf, bytes32[] calldata siblings) external view returns (bool) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0x00), leaf));
        for (uint256 i = 0; i < siblings.length; i++) {
            h = (index >> i) & 1 == 0
                ? keccak256(abi.encodePacked(bytes1(0x01), h, siblings[i]))
                : keccak256(abi.encodePacked(bytes1(0x01), siblings[i], h));
        }
        return h == rootOf[seller][batch];
    }
}
