// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMIP20Hold {
    function holdFrom(address owner, uint256 amount) external;
    function captureHold(address owner, address to, uint256 amount) external;
    function releaseHold(address owner, uint256 amount) external;
    function heldBalanceOf(address owner, address spender) external view returns (uint256);
}

/// The spender of each seller's dispute reserve. The court's key cannot move reserve
/// funds directly: it can only publish a ruling, which pays the named payer at most
/// `maxRefund`, once per payment, after an objection window the seller can use.
contract CourtVault {
    struct Ruling { address seller; address payer; uint256 refund; uint64 executableAt; uint8 state; } // 1 pending, 2 paid, 3 objected
    event RulingPublished(bytes32 indexed paymentTx, address indexed seller, address indexed payer, uint256 refund, string reasonCode, bytes32 evidenceRoot, uint64 executableAt);
    event RefundPaid(bytes32 indexed paymentTx, address indexed payer, uint256 refund);
    event Objected(bytes32 indexed paymentTx, address indexed seller);

    IMIP20Hold public immutable token;
    address public immutable court;
    uint256 public immutable maxRefund;
    uint64 public immutable objectionWindow;
    mapping(bytes32 => Ruling) public rulings;

    constructor(IMIP20Hold token_, address court_, uint256 maxRefund_, uint64 objectionWindow_) {
        token = token_; court = court_; maxRefund = maxRefund_; objectionWindow = objectionWindow_;
    }

    /// Seller funds its reserve (after approving this vault on the token).
    function reserve(uint256 amount) external { token.holdFrom(msg.sender, amount); }

    function rule(bytes32 paymentTx, address seller, address payer, uint256 refund, string calldata reasonCode, bytes32 evidenceRoot) external {
        require(msg.sender == court, "court only");
        require(rulings[paymentTx].state == 0, "already ruled");
        require(refund <= maxRefund, "refund above cap");
        uint64 at = uint64(block.timestamp) + objectionWindow;
        rulings[paymentTx] = Ruling(seller, payer, refund, at, 1);
        emit RulingPublished(paymentTx, seller, payer, refund, reasonCode, evidenceRoot, at);
    }

    function object(bytes32 paymentTx) external {
        Ruling storage r = rulings[paymentTx];
        require(r.state == 1 && msg.sender == r.seller && block.timestamp < r.executableAt, "cannot object");
        r.state = 3;
        emit Objected(paymentTx, msg.sender);
    }

    /// Anyone can execute a ruling once its objection window has passed.
    function execute(bytes32 paymentTx) external {
        Ruling storage r = rulings[paymentTx];
        require(r.state == 1 && block.timestamp >= r.executableAt, "not executable");
        r.state = 2;
        token.captureHold(r.seller, r.payer, r.refund);
        emit RefundPaid(paymentTx, r.payer, r.refund);
    }
}
