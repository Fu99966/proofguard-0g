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
    function setGuard(ProofGuardSafe value) external { guard = value; }

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external returns (bool) {
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ISSUER_KEY, guard.permitDigest(signed));
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
}
