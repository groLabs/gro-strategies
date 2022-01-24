// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

// For test suite
contract ForceSend {
    function go(address payable victim) external payable {
        selfdestruct(victim);
    }
}
