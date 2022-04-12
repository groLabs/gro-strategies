// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.10;

interface IVRewards {

    function balanceOf(address account) external view returns (uint256);

    function earned(address account) external view returns (uint256);

    function rewardRate() external view returns (uint256);

    function rewardToken() external view returns (address);

}
