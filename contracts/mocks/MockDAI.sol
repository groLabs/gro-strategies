// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "./MockERC20.sol";

contract MockDAI is MockERC20 {
    constructor() ERC20("DAI", "DAI") {
    }

    function faucet() external override {
        require(!claimed[msg.sender], 'Already claimed');
        claimed[msg.sender] = true;
        _mint(msg.sender, 1E22);
    }
}
