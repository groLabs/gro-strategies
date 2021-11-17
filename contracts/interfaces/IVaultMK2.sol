// SPDX-License-Identifier: AGPLv3

pragma solidity 0.8.4;

interface IVaultMK2 {
    function totalAssets() external view returns (uint256);

    function getStrategiesLength() external view returns (uint256);

    function strategyHarvestTrigger(uint256 index, uint256 callCost) external view returns (bool);

    function getStrategyAssets(uint256 index) external view returns (uint256);

    function token() external view returns (address);
}
