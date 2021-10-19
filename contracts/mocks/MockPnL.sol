// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "../interfaces/IPnL.sol";
import "../common/Constants.sol";

contract MockPnL is Constants, IPnL {

    uint256 public override lastGvtAssets;
    uint256 public override lastPwrdAssets;
    uint256 public totalProfit;

    function calcPnL() external view override returns (uint256, uint256) {
        return (lastGvtAssets, lastPwrdAssets);
    }

    function setLastGvtAssets(uint256 _lastGvtAssets) public {
        lastGvtAssets = _lastGvtAssets;
    }

    function setLastPwrdAssets(uint256 _lastPwrdAssets) public {
        lastPwrdAssets = _lastPwrdAssets;
    }

    function setTotalProfit(uint256 _totalProfit) public {
        totalProfit = _totalProfit;
    }

    function increaseGTokenLastAmount(bool pwrd, uint256 dollarAmount) external override {}

    function decreaseGTokenLastAmount(
        bool pwrd,
        uint256 dollarAmount,
        uint256 bonus
    ) external override {}

    function utilisationRatio() external view override returns (uint256) {
        return lastGvtAssets != 0 ? lastPwrdAssets * PERCENTAGE_DECIMAL_FACTOR / lastGvtAssets : 0;
    }

    function emergencyPnL() external override {}

    function recover() external override {}

    function distributeStrategyGainLoss(
        uint256 gain,
        uint256 loss,
        address reward
    ) external override {}

    function distributePriceChange(uint256 currentTotalAssets) external override {}
}
