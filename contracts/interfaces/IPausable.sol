// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

interface IPausable {
    function paused() external view returns (bool);
}
