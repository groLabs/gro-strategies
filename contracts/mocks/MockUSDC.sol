// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "./MockERC20.sol";

contract MockUSDC is MockERC20 {
    constructor() ERC20("USDC", "USDC") {
    }
    
    function faucet() external override {
        require(!claimed[msg.sender], 'Already claimed');
        claimed[msg.sender] = true;
        _mint(msg.sender, 1E10);
    }

    function decimals() public view virtual override returns (uint8) {
        return 6;
    }
}
