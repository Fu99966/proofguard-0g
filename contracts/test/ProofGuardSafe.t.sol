// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ProofGuardSafe} from "../src/ProofGuardSafe.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}

contract SafeHarness {
    ProofGuardSafe private guard;
    uint8 private moduleResult;
    function setGuard(ProofGuardSafe value) external { guard = value; }
    function setModuleResult(uint8 value) external { moduleResult = value; }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool) {
        if (moduleResult != 0) return moduleResult == 1;
        bytes32 hash = guard.checkModuleTransaction(to, value, data, operation, msg.sender);
        (bool success,) = to.call{value: value}(data);
        guard.checkAfterModuleExecution(hash, success);
        return success;
    }

    function ownerExecute(address to, bytes calldata data) external {
        guard.checkTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), "", msg.sender);
        (bool success,) = to.call(data);
        guard.checkAfterExecution(bytes32(0), success);
    }
}

contract Recorder {
    uint256 public invoked;
    function record(uint256 value) external { invoked = value; }
}

contract ProofGuardSafeTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ISSUER_KEY = 1;
    address private constant AGENT = address(2);
    SafeHarness private safe;
    Recorder private recorder;
    ProofGuardSafe private guard;
    bytes private data;

    function setUp() external {
        vm.chainId(84532);
        vm.warp(1000);
        safe = new SafeHarness();
        recorder = new Recorder();
        guard = new ProofGuardSafe(address(safe), AGENT, vm.addr(ISSUER_KEY));
        safe.setGuard(guard);
        data = abi.encodeCall(recorder.record, (42));
    }

    function permit(uint256 deadline) private view returns (ProofGuardSafe.Permit memory) {
        return ProofGuardSafe.Permit(address(safe), address(recorder), 0, keccak256(data), deadline,
            bytes12(uint96(1)), bytes32(uint256(1)));
    }

    function sign(ProofGuardSafe.Permit memory signed) private returns (bytes memory) {
        return signWith(signed, ISSUER_KEY);
    }

    function signWith(ProofGuardSafe.Permit memory signed, uint256 key) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, guard.permitDigest(signed));
        return abi.encodePacked(r, s, v);
    }

    function testNoPermitRevertsOnSafeOwnerPath() external {
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        safe.ownerExecute(address(recorder), data);
    }

    function testAuthorizedOwnerPathConsumesPermit() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        guard.authorizeOwnerTransaction(signed, sign(signed));
        safe.ownerExecute(address(recorder), data);
        require(recorder.invoked() == 42 && guard.used(signed.nonce));
    }

    function testAgentCanExecuteOnceAndReplayReverts() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        bytes memory sig = sign(signed);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, sig);
        require(recorder.invoked() == 42 && guard.used(signed.nonce));
        vm.expectRevert(ProofGuardSafe.ReplayedPermit.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, sig);
    }

    function testExpiredPermitReverts() external {
        ProofGuardSafe.Permit memory signed = permit(1000);
        bytes memory sig = sign(signed);
        vm.expectRevert(ProofGuardSafe.ExpiredPermit.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, sig);
    }

    function testChangedDataReverts() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        bytes memory sig = sign(signed);
        vm.expectRevert(ProofGuardSafe.TransactionMismatch.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, abi.encodeCall(recorder.record, (43)), signed, sig);
    }

    function testMissingAgentSignatureReverts() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, "");
    }

    function testUnregisteredCallerCannotSubmit() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        bytes memory sig = sign(signed);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        guard.executeGuarded(address(recorder), 0, data, signed, sig);
    }

    function testConstructorEnforcesTestnetAndDistinctRoles() external {
        address issuer = vm.addr(ISSUER_KEY);
        vm.chainId(31337);
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        new ProofGuardSafe(address(safe), AGENT, issuer);
        vm.chainId(84532);

        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(0xBEEF), AGENT, issuer);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(safe), address(0), issuer);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(safe), AGENT, address(0));
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(safe), issuer, issuer);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(safe), address(safe), issuer);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        new ProofGuardSafe(address(safe), AGENT, address(safe));
    }

    function testAgentCannotDirectlyTargetSafeOrGuard() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(safe), 0, data, signed, "");
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(guard), 0, data, signed, "");
    }

    function testModuleFailureOrMissingCallbackRevertsAndRestoresNonce() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        bytes memory signature = sign(signed);
        safe.setModuleResult(1);
        vm.expectRevert(ProofGuardSafe.ExecutionFailed.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, signature);
        require(!guard.used(signed.nonce), "missing callback consumed nonce");

        safe.setModuleResult(2);
        vm.expectRevert(ProofGuardSafe.ExecutionFailed.selector);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, signature);
        require(!guard.used(signed.nonce), "failed module consumed nonce");

        safe.setModuleResult(0);
        vm.prank(AGENT);
        guard.executeGuarded(address(recorder), 0, data, signed, signature);
        require(guard.used(signed.nonce) && recorder.invoked() == 42, "retry did not execute");
    }

    function testOnlySafeCanCallAnyHook() external {
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        guard.checkTransaction(address(recorder), 0, data, 0, 0, 0, 0, address(0), payable(address(0)), "", AGENT);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        guard.checkModuleTransaction(address(recorder), 0, data, 0, address(guard));
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        guard.checkAfterExecution(bytes32(0), true);
        vm.expectRevert(ProofGuardSafe.Unauthorized.selector);
        guard.checkAfterModuleExecution(bytes32(0), true);
    }

    function testOwnerHookRejectsDelegatecallAndRefundParameters() external {
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkTransaction(address(recorder), 0, data, 1, 0, 0, 0, address(0), payable(address(0)), "", AGENT);
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkTransaction(address(recorder), 0, data, 0, 0, 0, 1, address(0), payable(address(0)), "", AGENT);
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkTransaction(address(recorder), 0, data, 0, 0, 0, 0, address(recorder), payable(address(0)), "", AGENT);
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkTransaction(address(recorder), 0, data, 0, 0, 0, 0, address(0), payable(address(recorder)), "", AGENT);
    }

    function testModuleHookRejectsUnexpectedModeModuleOrAction() external {
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkModuleTransaction(address(recorder), 0, data, 1, address(guard));
        vm.expectRevert(ProofGuardSafe.UnsupportedExecution.selector);
        vm.prank(address(safe));
        guard.checkModuleTransaction(address(recorder), 0, data, 0, address(recorder));
        vm.expectRevert(ProofGuardSafe.MissingPermit.selector);
        vm.prank(address(safe));
        guard.checkModuleTransaction(address(recorder), 0, data, 0, address(guard));
    }

    function testPermitRequiresCorrectFromAndNonzeroPermitHash() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        signed.from = address(recorder);
        bytes memory signature = sign(signed);
        vm.expectRevert(ProofGuardSafe.TransactionMismatch.selector);
        guard.authorizeOwnerTransaction(signed, signature);

        signed = permit(2000);
        signed.permitHash = bytes32(0);
        signature = sign(signed);
        vm.expectRevert(ProofGuardSafe.TransactionMismatch.selector);
        guard.authorizeOwnerTransaction(signed, signature);
    }

    function testPermitRejectsWrongSignerAndNoncanonicalSignatures() external {
        ProofGuardSafe.Permit memory signed = permit(2000);
        bytes memory signature = signWith(signed, 7);
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        guard.authorizeOwnerTransaction(signed, signature);

        signature = sign(signed);
        signature[64] = bytes1(uint8(0));
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        guard.authorizeOwnerTransaction(signed, signature);

        signature = abi.encodePacked(bytes32(uint256(1)), bytes32(type(uint256).max), uint8(27));
        vm.expectRevert(ProofGuardSafe.InvalidSignature.selector);
        guard.authorizeOwnerTransaction(signed, signature);
    }

    function testOwnerPermitStagedBeforeExpirationStillExpiresBeforeExecution() external {
        ProofGuardSafe.Permit memory signed = permit(1001);
        guard.authorizeOwnerTransaction(signed, sign(signed));
        vm.warp(1001);
        vm.expectRevert(ProofGuardSafe.ExpiredPermit.selector);
        safe.ownerExecute(address(recorder), data);
        require(!guard.used(signed.nonce) && recorder.invoked() == 0, "expired owner action changed state");
    }

    function testOwnerPermitsStagedWithSameNonceCanBeConsumedOnlyOnce() external {
        ProofGuardSafe.Permit memory first = permit(2000);
        guard.authorizeOwnerTransaction(first, sign(first));
        bytes memory nextData = abi.encodeCall(recorder.record, (43));
        ProofGuardSafe.Permit memory second = permit(2000);
        second.dataHash = keccak256(nextData);
        guard.authorizeOwnerTransaction(second, sign(second));

        safe.ownerExecute(address(recorder), data);
        vm.expectRevert(ProofGuardSafe.ReplayedPermit.selector);
        safe.ownerExecute(address(recorder), nextData);
        require(guard.used(first.nonce) && recorder.invoked() == 42, "replayed owner action changed state");
    }
}
