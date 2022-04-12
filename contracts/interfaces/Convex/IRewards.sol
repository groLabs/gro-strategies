// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.10;

interface IRewards {
    function balanceOf(address account) external view returns (uint256);

    function earned(address account) external view returns (uint256);

    function withdrawAndUnwrap(uint256 amount, bool claim) external returns (bool);

    function withdrawAllAndUnwrap(bool claim) external;

    function getReward() external returns (bool);

    function periodFinish() external view returns (uint256);

    function rewardRate() external view returns (uint256);

    function extraRewardsLength() external view returns (uint256);

    function extraRewards(uint256 id) external view returns (address);
}
