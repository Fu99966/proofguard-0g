// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProofGuardSafe} from "../../src/ProofGuardSafe.sol";

interface ForkVm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
    function expectEmit(bool, bool, bool, bool, address emitter) external;
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function deal(address account, uint256 balance) external;
    function load(address account, bytes32 slot) external view returns (bytes32);
    function skip(bool skipTest) external;
}

interface SafeProxyFactoryV150 {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external returns (address);
}

interface SafeV150 {
    function setup(address[] calldata, uint256, address, bytes calldata, address, address, uint256, address) external;
    function VERSION() external view returns (string memory);
    function getThreshold() external view returns (uint256);
    function nonce() external view returns (uint256);
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas,
        uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) external view returns (bytes32);
    function isModuleEnabled(address module) external view returns (bool);
    function setGuard(address guard) external;
    function setModuleGuard(address guard) external;
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas,
        uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes calldata signatures)
        external returns (bool);
}

contract ForkRecorder {
    bool public reject;
    uint256 public calls;
    uint256 public lastValue;

    function setReject(bool value) external { reject = value; }

    function record(uint256 value) external {
        ++calls;
        lastValue = value;
        require(!reject, "fork fixture rejected action");
    }
}

abstract contract ForkSafeFixture {
    ForkVm internal constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant FORK_BLOCK = 61349084;
    address internal constant SINGLETON = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    address internal constant FACTORY = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    bytes32 internal constant TX_GUARD_SLOT = keccak256("guard_manager.guard.address");
    bytes32 internal constant MODULE_GUARD_SLOT = keccak256("module_manager.module_guard.address");
    uint256 internal constant ISSUER_KEY = 0x101;
    uint256 internal constant REPLACEMENT_ISSUER_KEY = 0x102;
    address internal constant AGENT = address(0xA61);
    address internal constant OWNER = address(0xA62);

    SafeV150 internal safe;
    ForkRecorder internal recorder;
    ProofGuardSafe internal guard;

    event PermitConsumed(bytes32 indexed permitHash, bytes12 indexed nonce, address indexed target);
    event IssuerRecovered(address indexed previousIssuer, address indexed newIssuer, uint256 indexed epoch);

    function setUp() public virtual {
        if (block.chainid == 31337) vm.skip(true);
        require(block.chainid == 84532 && block.number == FORK_BLOCK, "wrong Base Sepolia fork");
        require(SINGLETON.codehash == 0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc,
            "unexpected Safe singleton");
        require(FACTORY.codehash == 0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529,
            "unexpected Safe factory");

        address[] memory owners = new address[](1);
        owners[0] = OWNER;
        bytes memory initializer = abi.encodeCall(SafeV150.setup,
            (owners, 1, address(0), "", address(0), address(0), 0, address(0)));
        safe = SafeV150(SafeProxyFactoryV150(FACTORY).createProxyWithNonce(SINGLETON, initializer, 0xA65));
        require(keccak256(bytes(safe.VERSION())) == keccak256("1.5.0") && safe.getThreshold() == 1,
            "unexpected Safe proxy");

        recorder = new ForkRecorder();
        guard = new ProofGuardSafe(address(safe), AGENT, vm.addr(ISSUER_KEY));
        require(_owner(address(safe), abi.encodeCall(SafeV150.enableModule, (address(guard))), 0), "enable module");
        require(_owner(address(safe), abi.encodeCall(SafeV150.setModuleGuard, (address(guard))), 0), "set module guard");
        require(_owner(address(safe), abi.encodeCall(SafeV150.setGuard, (address(guard))), 0), "set owner guard");
        _assertGuards(guard);
    }

    function _permit(address to, bytes memory data, uint96 permitNonce, uint256 deadline)
        internal view returns (ProofGuardSafe.Permit memory)
    {
        return ProofGuardSafe.Permit(address(safe), to, 0, keccak256(data), deadline, bytes12(permitNonce),
            bytes32(uint256(permitNonce)));
    }

    function _sign(ProofGuardSafe current, ProofGuardSafe.Permit memory permit, uint256 key)
        internal returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, current.permitDigest(permit));
        return abi.encodePacked(r, s, v);
    }

    function _owner(address target, bytes memory data, uint256 safeTxGas) internal returns (bool) {
        bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(OWNER))), bytes32(0), uint8(1));
        vm.prank(OWNER);
        return safe.execTransaction(target, 0, data, 0, safeTxGas, 0, 0, address(0), address(0), signature);
    }

    function _ownerManagement(ProofGuardSafe current, uint256 key, bytes memory data, uint96 permitNonce) internal {
        ProofGuardSafe.Permit memory permit = _permit(address(safe), data, permitNonce, block.timestamp + 300);
        current.authorizeOwnerTransaction(permit, _sign(current, permit, key));
        require(_owner(address(safe), data, 0), "Safe management execution failed");
        require(current.used(permit.nonce), "management permit was not consumed");
    }

    function _assertGuards(ProofGuardSafe current) internal view {
        require(address(uint160(uint256(vm.load(address(safe), TX_GUARD_SLOT)))) == address(current), "owner guard slot");
        require(address(uint160(uint256(vm.load(address(safe), MODULE_GUARD_SLOT)))) == address(current), "module guard slot");
        require(safe.isModuleEnabled(address(current)), "guard module not enabled");
    }
}

contract ProofGuardSafeForkTest is ForkSafeFixture {
    function _recover(address newIssuer) private {
        require(_owner(address(guard), abi.encodeCall(ProofGuardSafe.recoverIssuer, (newIssuer)), 0), "recovery failed");
    }

    function testForkLostIssuerOwnerRecoversInOneTransaction() external {
        address previous = guard.issuer();
        address replacement = vm.addr(REPLACEMENT_ISSUER_KEY);
        uint256 startNonce = safe.nonce();
        vm.expectEmit(true, true, true, true, address(guard));
        emit IssuerRecovered(previous, replacement, 1);
        _recover(replacement);
        require(safe.nonce() == startNonce + 1 && guard.issuer() == replacement && guard.issuerEpoch() == 1
            && guard.agentPaused(), "non-atomic recovery");
        _assertGuards(guard);
    }

    function testForkCompromisedIssuerCannotRecoverOrKeepSigning() external {
        address oldIssuer = guard.issuer();
        address replacement = vm.addr(REPLACEMENT_ISSUER_KEY);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        vm.prank(AGENT);
        guard.recoverIssuer(replacement);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        vm.prank(oldIssuer);
        guard.recoverIssuer(replacement);

        bytes memory data = abi.encodeCall(ForkRecorder.record, (44));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 61, block.timestamp + 300);
        guard.authorizeOwnerTransaction(permit, _sign(guard, permit, ISSUER_KEY));
        _recover(replacement);
        bytes memory leakedSignature = _sign(guard, permit, ISSUER_KEY);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        vm.prank(oldIssuer);
        guard.authorizeOwnerTransaction(permit, leakedSignature);
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(recorder), data, 0);

        bytes memory replacementSignature = _sign(guard, permit, REPLACEMENT_ISSUER_KEY);
        vm.expectRevert(ProofGuardSafe.AgentPaused.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, replacementSignature);
        require(recorder.calls() == 0 && !guard.used(permit.nonce), "paused transaction changed state");
    }

    function testForkRecoveryRequiresSafeOwnerThreshold() external {
        uint256 secondKey = 0x103;
        address second = vm.addr(secondKey);
        _ownerManagement(guard, ISSUER_KEY, abi.encodeCall(SafeV150.addOwnerWithThreshold, (second, 2)), 62);
        address replacement = vm.addr(REPLACEMENT_ISSUER_KEY);
        bytes memory message = abi.encodeCall(ProofGuardSafe.recoverIssuer, (replacement));
        uint256 startNonce = safe.nonce();
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "GS020"));
        _owner(address(guard), message, 0);
        require(guard.issuerEpoch() == 0 && !guard.agentPaused() && safe.nonce() == startNonce, "sub-threshold recovery");

        bytes32 digest = safe.getTransactionHash(address(guard), 0, message, 0, 0, 0, 0, address(0), address(0), startNonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(secondKey, digest);
        bytes memory a = abi.encodePacked(bytes32(uint256(uint160(OWNER))), bytes32(0), uint8(1));
        bytes memory b = abi.encodePacked(r, s, v);
        bytes memory signatures = OWNER < second ? bytes.concat(a, b) : bytes.concat(b, a);
        vm.prank(OWNER);
        require(safe.execTransaction(address(guard), 0, message, 0, 0, 0, 0, address(0), address(0), signatures), "quorum recovery");
        require(guard.issuer() == replacement && guard.issuerEpoch() == 1 && guard.agentPaused(), "quorum failed");
    }

    function testForkOldPermitsNeverReviveAfterRecovery() external {
        address initialIssuer = guard.issuer();
        bytes memory data = abi.encodeCall(ForkRecorder.record, (45));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 63, block.timestamp + 300);
        bytes memory oldSignature = _sign(guard, permit, ISSUER_KEY);
        guard.authorizeOwnerTransaction(permit, oldSignature);
        _recover(vm.addr(REPLACEMENT_ISSUER_KEY));
        // Even rotating back to the same address cannot revalidate an older signature or registration.
        _recover(initialIssuer);
        require(_owner(address(guard), abi.encodeCall(ProofGuardSafe.resumeAgent, ()), 0), "resume failed");
        require(!guard.agentPaused() && guard.issuerEpoch() == 2, "wrong resumed state");
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(recorder), data, 0);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        guard.authorizeOwnerTransaction(permit, oldSignature);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, oldSignature);
        bytes memory freshSignature = _sign(guard, permit, ISSUER_KEY);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, freshSignature);
        require(recorder.calls() == 1 && guard.used(permit.nonce), "new epoch failed");
    }

    function testForkRealSafeAcceptsERC165AndBothGuardInterfaces() external view {
        require(guard.supportsInterface(0x01ffc9a7), "missing ERC165");
        require(guard.supportsInterface(0xe6d7a83a), "missing transaction guard interface");
        require(guard.supportsInterface(0x58401ed8), "missing module guard interface");
        require(!guard.supportsInterface(0xffffffff), "invalid ERC165 interface accepted");
        _assertGuards(guard);
    }

    function testForkRealSafeOwnerPermitConsumesAndTriggersHooks() external {
        bytes memory data = abi.encodeCall(ForkRecorder.record, (41));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 1, block.timestamp + 300);
        uint256 startNonce = safe.nonce();
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(recorder), data, 0);
        require(safe.nonce() == startNonce && recorder.calls() == 0, "blocked owner action changed state");

        guard.authorizeOwnerTransaction(permit, _sign(guard, permit, ISSUER_KEY));
        vm.expectEmit(true, true, true, true, address(guard));
        emit PermitConsumed(permit.permitHash, permit.nonce, address(recorder));
        require(_owner(address(recorder), data, 0), "owner execution failed");
        require(safe.nonce() == startNonce + 1 && guard.used(permit.nonce), "owner transaction did not consume nonce");
        require(recorder.calls() == 1 && recorder.lastValue() == 41, "owner action did not reach target");
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(recorder), data, 0);
    }

    function testForkRealSafeModulePermitConsumesAndTriggersHooks() external {
        bytes memory data = abi.encodeCall(ForkRecorder.record, (42));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 2, block.timestamp + 300);
        bytes memory signature = _sign(guard, permit, ISSUER_KEY);
        uint256 startNonce = safe.nonce();
        vm.expectEmit(true, true, true, true, address(guard));
        emit PermitConsumed(permit.permitHash, permit.nonce, address(recorder));
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, signature);
        require(safe.nonce() == startNonce && guard.used(permit.nonce), "module affected owner nonce or failed to consume");
        require(recorder.calls() == 1 && recorder.lastValue() == 42, "module action did not reach target");
        vm.expectRevert(ProofGuardSafe.ReplayedPermit.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, signature);
    }

    function testForkOwnerFailureRollsBackAndSamePermitCanRecover() external {
        bytes memory data = abi.encodeCall(ForkRecorder.record, (43));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 3, block.timestamp + 300);
        guard.authorizeOwnerTransaction(permit, _sign(guard, permit, ISSUER_KEY));
        uint256 startNonce = safe.nonce();

        recorder.setReject(true);
        // Nonzero safeTxGas makes the real Safe deliver failure to checkAfterExecution.
        vm.expectRevert(ProofGuardSafe.ExecutionFailed.selector);
        _owner(address(recorder), data, 100_000);
        require(safe.nonce() == startNonce && !guard.used(permit.nonce) && recorder.calls() == 0, "owner rollback");

        recorder.setReject(false);
        require(_owner(address(recorder), data, 100_000), "owner retry failed");
        require(safe.nonce() == startNonce + 1 && guard.used(permit.nonce) && recorder.calls() == 1, "owner recovery");
    }

    function testForkModuleFailureRollsBackAndSamePermitCanRecover() external {
        bytes memory data = abi.encodeCall(ForkRecorder.record, (44));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 4, block.timestamp + 300);
        bytes memory signature = _sign(guard, permit, ISSUER_KEY);
        uint256 startNonce = safe.nonce();

        recorder.setReject(true);
        vm.expectRevert(ProofGuardSafe.ExecutionFailed.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, signature);
        require(safe.nonce() == startNonce && !guard.used(permit.nonce) && recorder.calls() == 0, "module rollback");

        recorder.setReject(false);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, permit, signature);
        require(safe.nonce() == startNonce && guard.used(permit.nonce) && recorder.calls() == 1, "module recovery");
    }

    function testForkReplacementRequiresCurrentIssuerAndRestoresBothPaths() external {
        ProofGuardSafe replacement = new ProofGuardSafe(address(safe), AGENT, vm.addr(REPLACEMENT_ISSUER_KEY));
        bytes memory changeGuard = abi.encodeCall(SafeV150.setGuard, (address(replacement)));
        ProofGuardSafe.Permit memory missing = _permit(address(safe), changeGuard, 10, block.timestamp + 300);
        bytes memory wrongSignature = _sign(guard, missing, REPLACEMENT_ISSUER_KEY);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        guard.authorizeOwnerTransaction(missing, wrongSignature);
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(safe), changeGuard, 0);
        _assertGuards(guard);

        _ownerManagement(guard, ISSUER_KEY, abi.encodeCall(SafeV150.enableModule, (address(replacement))), 10);
        _ownerManagement(guard, ISSUER_KEY, abi.encodeCall(SafeV150.setModuleGuard, (address(replacement))), 11);
        _ownerManagement(guard, ISSUER_KEY, changeGuard, 12);
        _ownerManagement(replacement, REPLACEMENT_ISSUER_KEY,
            abi.encodeCall(SafeV150.disableModule, (address(replacement), address(guard))), 13);
        _assertGuards(replacement);
        require(!safe.isModuleEnabled(address(guard)), "old guard module still enabled");

        bytes memory data = abi.encodeCall(ForkRecorder.record, (45));
        ProofGuardSafe.Permit memory permit = _permit(address(recorder), data, 14, block.timestamp + 300);
        bytes memory oldSignature = _sign(guard, permit, ISSUER_KEY);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        replacement.authorizeOwnerTransaction(permit, oldSignature);
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        _owner(address(recorder), data, 0);
        replacement.authorizeOwnerTransaction(permit, _sign(replacement, permit, REPLACEMENT_ISSUER_KEY));
        require(_owner(address(recorder), data, 0) && replacement.used(permit.nonce), "replacement owner path failed");

        permit = _permit(address(recorder), data, 15, block.timestamp + 300);
        bytes memory signature = _sign(replacement, permit, REPLACEMENT_ISSUER_KEY);
        vm.prank(AGENT);
        replacement.executeGuarded(address(recorder), 0, data, permit, signature);
        require(recorder.calls() == 2 && replacement.used(permit.nonce), "replacement module path failed");
    }
}

contract InvalidPermitHandler {
    ForkVm private constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SafeV150 private immutable safe;
    ProofGuardSafe private immutable guard;
    ForkRecorder private immutable recorder;
    address private immutable owner;
    address private immutable agent;
    uint256 private immutable issuerKey;

    bool public unexpectedSuccess;
    uint256 public ownerAttempts;
    uint256 public moduleAttempts;

    constructor(SafeV150 account, ProofGuardSafe current, ForkRecorder target, address safeOwner, address safeAgent, uint256 key) {
        safe = account;
        guard = current;
        recorder = target;
        owner = safeOwner;
        agent = safeAgent;
        issuerKey = key;
    }

    function ownerWithoutValidPermit(uint96 input, uint8 flavor) external {
        // The fixture reserves actions 100 and 101 for expired and consumed staged permits.
        uint256 value = flavor % 3 == 0 ? 2 ** 96 + uint256(input) : 99 + flavor % 3;
        bytes memory data = abi.encodeCall(ForkRecorder.record, (value));
        bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        bytes memory transaction = abi.encodeCall(SafeV150.execTransaction,
            (address(recorder), 0, data, 0, 0, 0, 0, address(0), address(0), signature));
        ++ownerAttempts;
        vm.prank(owner);
        (bool ok,) = address(safe).call(transaction);
        if (ok) unexpectedSuccess = true;
    }

    function moduleWithoutValidPermit(uint96 input, uint8 flavor) external {
        uint8 fault = flavor % 5;
        bytes memory data = abi.encodeCall(ForkRecorder.record, (input));
        bytes12 nonce = bytes12(fault == 4 ? uint96(102) : input);
        uint256 deadline = fault == 1 ? block.timestamp : block.timestamp + 300;
        bytes32 dataHash = fault == 3 ? keccak256(abi.encodeCall(ForkRecorder.record, (2 ** 96 + uint256(input)))) : keccak256(data);
        ProofGuardSafe.Permit memory permit = ProofGuardSafe.Permit(address(safe), address(recorder), 0, dataHash,
            deadline, nonce, bytes32(uint256(1)));

        bytes memory signature;
        if (fault != 0) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(fault == 2 ? issuerKey + 1 : issuerKey, guard.permitDigest(permit));
            signature = abi.encodePacked(r, s, v);
        }
        bytes memory transaction = abi.encodeCall(guard.executeGuarded, (address(recorder), 0, data, permit, signature));
        ++moduleAttempts;
        vm.prank(agent);
        (bool ok,) = address(guard).call(transaction);
        if (ok) unexpectedSuccess = true;
    }
}

contract ProofGuardSafeForkInvariantTest is ForkSafeFixture {
    address private constant FUZZ_RELAYER = address(0xA63);
    InvalidPermitHandler private handler;
    uint256 private baselineSafeNonce;

    function setUp() public override {
        super.setUp();
        uint256 expiry = block.timestamp + 60;
        bytes memory expiredData = abi.encodeCall(ForkRecorder.record, (100));
        ProofGuardSafe.Permit memory expired = _permit(address(recorder), expiredData, 100, expiry);
        guard.authorizeOwnerTransaction(expired, _sign(guard, expired, ISSUER_KEY));

        bytes memory replayData = abi.encodeCall(ForkRecorder.record, (101));
        ProofGuardSafe.Permit memory replay = _permit(address(recorder), replayData, 102, expiry + 300);
        guard.authorizeOwnerTransaction(replay, _sign(guard, replay, ISSUER_KEY));
        bytes memory seedData = abi.encodeCall(ForkRecorder.record, (102));
        ProofGuardSafe.Permit memory seed = _permit(address(recorder), seedData, 102, expiry + 300);
        guard.authorizeOwnerTransaction(seed, _sign(guard, seed, ISSUER_KEY));
        require(_owner(address(recorder), seedData, 0) && guard.used(seed.nonce), "invariant fixture did not consume nonce");
        baselineSafeNonce = safe.nonce();
        vm.warp(expiry);
        // The fork's OP Stack transaction fees require a local balance for the fuzz relayer.
        vm.deal(FUZZ_RELAYER, 1 ether);
        handler = new InvalidPermitHandler(safe, guard, recorder, OWNER, AGENT, ISSUER_KEY);
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSenders() external pure returns (address[] memory senders) {
        senders = new address[](1);
        senders[0] = FUZZ_RELAYER;
    }

    function invariantSafeExecutionRevertsWithoutValidPermit() external view {
        require(!handler.unexpectedSuccess(), "invalid permit call did not revert");
        require(recorder.calls() == 1 && recorder.lastValue() == 102, "invalid permit reached target");
        require(safe.nonce() == baselineSafeNonce, "invalid permit changed Safe nonce");
        require(!guard.used(bytes12(uint96(100))), "invalid permit consumed expired nonce");
    }
}
