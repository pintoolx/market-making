// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IReportReceiver} from "../AquaGuard.sol";

/// @notice Test harness only. This is not Chainlink's forwarder or proof of TEE execution.
contract GuardTestForwarder {
    address public immutable owner = msg.sender;
    error OnlyTestOwner();

    function forward(address receiver, bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != owner) revert OnlyTestOwner();
        IReportReceiver(receiver).onReport(metadata, report);
    }
}
