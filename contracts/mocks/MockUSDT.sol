// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "./MockERC20.sol";

contract MockUSDT is MockERC20 {
    constructor() ERC20("USDT", "USDT") {}

    function faucet() external override {
        require(!claimed[msg.sender], "Already claimed");
        claimed[msg.sender] = true;
        _mint(msg.sender, 1E10);
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }
}
