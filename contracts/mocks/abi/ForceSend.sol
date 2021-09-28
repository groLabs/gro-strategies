// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

// For test suite
contract ForceSend {
    function go(address payable victim) external payable {
        selfdestruct(victim);
    }
}
