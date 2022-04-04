// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.10;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../BaseStrategy.sol";


/*
 * This Strategy serves as both a mock Strategy for testing, and an example
 * for integrators on how to use BaseStrategy
 */

contract TestStrategy is BaseStrategy {
    bool public doReentrancy;
    bool public ammStatus = true;
    bool noLoss = false;
    bool toMuchGain = false;
    bool toMuchLoss = false;

    constructor(address _vault) BaseStrategy(_vault) {}

    function name() external override pure returns (string memory) {
        return "TestStrategy";
    }

    // NOTE: This is a test-only function to simulate losses
    function _takeFunds(uint256 amount) public {
        want.transfer(msg.sender, amount);
    }

    // NOTE: This is a test-only function to enable reentrancy on withdraw
    function _toggleReentrancyExploit() public {
        doReentrancy = !doReentrancy;
    }

    function estimatedTotalAssets() external override view returns (uint256) {
        // For mock, this is just everything we have
        return _estimatedTotalAssets();
    }

    function _prepareReturn(uint256 _debtOutstanding)
        internal
        view
        returns (
            uint256 profit,
            uint256 loss,
            uint256 debtPayment
        )
    {
        // During testing, send this contract some tokens to simulate "Rewards"
        uint256 totalAssets = want.balanceOf(address(this));
        uint256 totalDebt = vault.strategies(address(this)).totalDebt;
        if (totalAssets > _debtOutstanding) {
            debtPayment = _debtOutstanding;
            totalAssets -= _debtOutstanding;
        } else {
            debtPayment = totalAssets;
            totalAssets = 0;
        }
        totalDebt -= debtPayment;

        if (totalAssets > totalDebt) {
            profit = totalAssets - totalDebt;
        } else {
            loss = totalDebt - totalAssets;
        }
        if (toMuchGain) {
            profit = profit * 5;
        }
        if (toMuchLoss) {
            loss = totalDebt * 2;
        }
    }

    function _adjustPosition(uint256 _debtOutstanding) internal {
        // Whatever we have "free", consider it "invested" now
    }

    function setToMuchGain() external {
        toMuchGain = true;
    }

    function setToMuchLoss() external {
        toMuchLoss = true;
    }

    function setNoLossStrategy() external {
        noLoss = true;
    }

    function _liquidatePosition(uint256 _amountNeeded) internal view override returns (uint256 liquidatedAmount, uint256 loss) {
        uint256 totalDebt = vault.strategies(address(this)).totalDebt;
        uint256 totalAssets = want.balanceOf(address(this));
        if (_amountNeeded > totalAssets) {
            liquidatedAmount = totalAssets;
            if (!noLoss) {
                loss = _amountNeeded - totalAssets;
            }
        } else {
            // NOTE: Just in case something was stolen from this contract
            if (totalDebt > totalAssets) {
                if (!noLoss) {
                    loss = totalDebt - totalAssets;
                    if (loss > _amountNeeded) loss = _amountNeeded;
                }
            }
            if (!noLoss) {
                liquidatedAmount = _amountNeeded - loss;
            } else {
                if (_amountNeeded > totalAssets) {
                    liquidatedAmount = totalAssets;
                } else {
                    liquidatedAmount = _amountNeeded;
                }
            }
        }
    }

    function harvestTrigger(uint256 _callCost)
        public
        view
        override
        returns (bool)
    {
        StrategyParams memory params = vault.strategies(address(this));

        // Should not trigger if Strategy is not activated
        if (params.activation == 0) return false;

        // Should not trigger if we haven't waited long enough since previous harvest
        if (block.timestamp - params.lastReport < minReportDelay) return false;

        // Should trigger if hasn't been called in a while
        if (block.timestamp - params.lastReport >= maxReportDelay) return true;

        // If some amount is owed, pay it back
        // NOTE: Since debt is based on deposits, it makes sense to guard against large
        //       changes to the value from triggering a harvest directly through user
        //       behavior. This should ensure reasonable resistance to manipulation
        //       from user-initiated withdrawals as the outstanding debt fluctuates.
        uint256 outstanding = vault.debtOutstanding();
        if (outstanding > debtThreshold) return true;

        // Check for profits and losses
        uint256 total = _estimatedTotalAssets();
        // Trigger if we have a loss to report
        if (total + debtThreshold < params.totalDebt) return true;

        uint256 profit = 0;
        if (total > params.totalDebt) profit = total - params.totalDebt; // We've earned a profit!

        // Otherwise, only trigger if it "makes sense" economically (gas cost
        // is <N% of value moved)
        uint256 credit = vault.creditAvailable();
        return (_callCost < credit + profit);
    }

    function harvest() external override {
        require(msg.sender == address(vault), "harvest: !vault");
        uint256 profit = 0;
        uint256 loss = 0;
        uint256 debtOutstanding = vault.debtOutstanding();
        uint256 debtPayment = 0;
        if (emergencyExit) {
            // Free up as much capital as possible
            uint256 totalAssets = _estimatedTotalAssets();
            // NOTE: use the larger of total assets or debt outstanding to book losses properly
            (debtPayment, loss) = _liquidatePosition(
                totalAssets > debtOutstanding ? totalAssets : debtOutstanding
            );
            // NOTE: take up any remainder here as profit
            if (debtPayment > debtOutstanding) {
                profit = debtPayment - debtOutstanding;
                debtPayment = debtOutstanding;
            }
        } else {
            // Free up returns for Vault to pull
            (profit, loss, debtPayment) = _prepareReturn(debtOutstanding);
        }
        // Allow Vault to take up to the "harvested" balance of this contract,
        // which is the amount it has earned since the last time it reported to
        // the Vault.
        debtOutstanding = vault.report(profit, loss, debtPayment);

        // Check if free returns are left, and re-invest them
        _adjustPosition(debtOutstanding);

        emit LogHarvested(profit, loss, debtPayment, debtOutstanding);
    }

    function _estimatedTotalAssets() internal view returns (uint256) {
        return want.balanceOf(address(this));
    }

    function expectedReturn() external view returns (uint256) {
        uint256 estimateAssets = _estimatedTotalAssets();

        uint256 debt = vault.strategies(address(this)).totalDebt;
        if (debt > estimateAssets) {
            return 0;
        } else {
            return estimateAssets - debt;
        }
    }

    function tendTrigger(uint256 callCost) public pure override returns (bool) {
        if (callCost > 0) return false;
        return true;
    }

    function setAmmCheck(bool status) external {
        ammStatus = status;
    }
}
