// SPDX-License-Identifier: AGPLv3
pragma solidity >=0.6.0 <0.7.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../interfaces/IController.sol";
import "../interfaces/IPausable.sol";

contract Controllable is Ownable {
    address private _controller;

    event ChangeController(address indexed oldController, address indexed newController);

    /// Modifier to make a function callable only when the contract is not paused.
    /// Requirements:
    /// - The contract must not be paused.
    modifier whenNotPaused() {
        require(!_pausable().paused(), "Pausable: paused");
        _;
    }

    /// Modifier to make a function callable only when the contract is paused
    /// Requirements:
    /// - The contract must be paused
    modifier whenPaused() {
        require(_pausable().paused(), "Pausable: not paused");
        _;
    }

    /// @notice Returns true if the contract is paused, and false otherwise
    function ctrlPaused() public view returns (bool) {
        return _pausable().paused();
    }

    function setController(address newController) external onlyOwner {
        require(newController != address(0), "setController: 0x");
        address oldController = _controller;
        _controller = newController;
        emit ChangeController(oldController, newController);
    }

    function removeController() external onlyOwner {
        require(_controller != address(0), "controller: Controller already empty");
        address oldController = _controller;
        _controller = address(0);
        emit ChangeController(oldController, address(0));
    }

    function controller() public view returns (address) {
        require(_controller != address(0), "controller: Controller not set");
        return _controller;
    }

    function ctrl() internal view returns (IController) {
        require(_controller != address(0), "ctrl: Controller not set");
        return IController(_controller);
    }

    function _pausable() internal view returns (IPausable) {
        require(_controller != address(0), "_pausable: Controller not set");
        return IPausable(_controller);
    }
}
