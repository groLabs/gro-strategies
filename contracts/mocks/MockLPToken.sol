// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "./MockERC20.sol";

contract MockLPToken is MockERC20 {
    constructor() public ERC20("LPT", "LPT") {
    }

    function faucet() external override {
    }
}
