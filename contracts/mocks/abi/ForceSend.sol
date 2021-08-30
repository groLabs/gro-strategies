// SPDX-License-Identifier: AGPLv3
pragma solidity >=0.6.0 <0.7.0;

// For test suite
contract ForceSend {
    function go(address payable victim) external payable {
        selfdestruct(victim);
    }
}
