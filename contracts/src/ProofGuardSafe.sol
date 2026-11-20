// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ISafeModuleExecutor {
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external returns (bool);
}

contract ProofGuardSafe {
    struct Permit {
        address from;
        address to;
        uint256 value;
        bytes32 dataHash;
        uint256 deadline;
        bytes12 nonce;
        bytes32 permitHash;
    }

    bytes32 private constant DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RECOVERY_DOMAIN_TYPE = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
    bytes32 private constant PERMIT_TYPE = keccak256("Permit(address from,address to,uint256 value,bytes32 dataHash,uint256 deadline,bytes12 nonce,bytes32 permitHash)");
    uint256 private constant HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    error Unauthorized();
    error UnsupportedExecution();
    error MissingPermit();
    error ExpiredPermit();
    error ReplayedPermit();
    error TransactionMismatch();
    error InvalidSignature();
    error ExecutionFailed();
    error AgentPaused();

    address public immutable safe;
    address public immutable agent;
    address public issuer;
    uint256 public issuerEpoch;
    bool public agentPaused;
    mapping(bytes12 => bool) public used;
    mapping(bytes32 => Permit) private ownerPermits;
    bytes32 private pendingModuleHash;

    event PermitConsumed(bytes32 indexed permitHash, bytes12 indexed nonce, address indexed target);
    event IssuerRecovered(address indexed previousIssuer, address indexed newIssuer, uint256 indexed epoch);
    event AgentResumed(uint256 indexed epoch);

    constructor(address safeAddress, address agentAddress, address issuerAddress) {
        if (block.chainid != 84532) revert UnsupportedExecution();
        if (safeAddress.code.length == 0 || agentAddress == address(0) || issuerAddress == address(0)
            || agentAddress == issuerAddress || agentAddress == safeAddress || issuerAddress == safeAddress) revert Unauthorized();
        safe = safeAddress;
        agent = agentAddress;
        issuer = issuerAddress;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0xe6d7a83a || interfaceId == 0x58401ed8;
    }

    function permitDigest(Permit memory permit) public view returns (bytes32) {
        uint256 epoch = issuerEpoch;
        bytes32 domain = epoch == 0
            ? keccak256(abi.encode(DOMAIN_TYPE, keccak256("ProofGuard"), keccak256("1"), block.chainid, address(this)))
            : keccak256(abi.encode(RECOVERY_DOMAIN_TYPE, keccak256("ProofGuard"), keccak256("1"), block.chainid, address(this), bytes32(epoch)));
        bytes32 message = keccak256(abi.encode(PERMIT_TYPE, permit.from, permit.to, permit.value, permit.dataHash,
            permit.deadline, permit.nonce, permit.permitHash));
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function recoverIssuer(address newIssuer) external {
        _requireSafe();
        address previousIssuer = issuer;
        if (newIssuer == address(0) || newIssuer == previousIssuer || newIssuer == safe || newIssuer == agent
            || newIssuer == address(this)) revert Unauthorized();
        issuer = newIssuer;
        uint256 epoch = ++issuerEpoch;
        agentPaused = true;
        emit IssuerRecovered(previousIssuer, newIssuer, epoch);
    }

    function resumeAgent() external {
        _requireSafe();
        agentPaused = false;
        emit AgentResumed(issuerEpoch);
    }

    function authorizeOwnerTransaction(Permit calldata permit, bytes calldata signature) external {
        _verify(permit, signature);
        ownerPermits[_actionHash(permit.to, permit.value, permit.dataHash)] = permit;
    }

    function executeGuarded(address to, uint256 value, bytes calldata data, Permit calldata permit, bytes calldata signature) external {
        if (msg.sender != agent) revert Unauthorized();
        if (agentPaused) revert AgentPaused();
        if (to == safe || to == address(this) || pendingModuleHash != bytes32(0)) revert UnsupportedExecution();
        if (permit.to != to || permit.value != value || permit.dataHash != keccak256(data)) revert TransactionMismatch();
        _verify(permit, signature);
        _consume(permit);
        pendingModuleHash = _actionHash(to, value, permit.dataHash);
        if (!ISafeModuleExecutor(safe).execTransactionFromModule(to, value, data, 0) || pendingModuleHash != bytes32(0)) {
            revert ExecutionFailed();
        }
    }

    function checkTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256, uint256,
        uint256 gasPrice, address gasToken, address payable refundReceiver, bytes calldata, address executor) external {
        _requireSafe();
        if (operation != 0 || gasPrice != 0 || gasToken != address(0) || refundReceiver != address(0)) revert UnsupportedExecution();
        if (to == address(this) && value == 0 && ((data.length == 36 && bytes4(data) == this.recoverIssuer.selector)
            || (data.length == 4 && bytes4(data) == this.resumeAgent.selector))) {
            if (executor == agent || executor == issuer) revert Unauthorized();
            return;
        }
        bytes32 action = _actionHash(to, value, keccak256(data));
        Permit memory permit = ownerPermits[action];
        if (permit.permitHash == bytes32(0)) revert MissingPermit();
        _consume(permit);
        delete ownerPermits[action];
    }

    function checkModuleTransaction(address to, uint256 value, bytes calldata data, uint8 operation, address module)
        external returns (bytes32 action) {
        _requireSafe();
        if (operation != 0 || module != address(this)) revert UnsupportedExecution();
        action = _actionHash(to, value, keccak256(data));
        if (action != pendingModuleHash) revert MissingPermit();
        pendingModuleHash = bytes32(0);
    }

    function checkAfterExecution(bytes32, bool success) external view {
        _requireSafe();
        if (!success) revert ExecutionFailed();
    }

    function checkAfterModuleExecution(bytes32, bool success) external view {
        _requireSafe();
        if (!success) revert ExecutionFailed();
    }

    function _requireSafe() private view {
        if (msg.sender != safe) revert Unauthorized();
    }

    function _actionHash(address to, uint256 value, bytes32 dataHash) private view returns (bytes32) {
        return keccak256(abi.encode(issuerEpoch, to, value, dataHash));
    }

    function _verify(Permit memory permit, bytes calldata signature) private view {
        if (permit.from != safe || permit.permitHash == bytes32(0)) revert TransactionMismatch();
        if (permit.deadline <= block.timestamp) revert ExpiredPermit();
        if (used[permit.nonce]) revert ReplayedPermit();
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > HALF_CURVE_ORDER || (v != 27 && v != 28) || ecrecover(permitDigest(permit), v, r, s) != issuer) {
            revert InvalidSignature();
        }
    }

    function _consume(Permit memory permit) private {
        if (permit.deadline <= block.timestamp) revert ExpiredPermit();
        if (used[permit.nonce]) revert ReplayedPermit();
        used[permit.nonce] = true;
        emit PermitConsumed(permit.permitHash, permit.nonce, permit.to);
    }
}
