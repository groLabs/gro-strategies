// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;
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

    function estimatedTotalAssets() public override view returns (uint256) {
        // For mock, this is just everything we have
        return want.balanceOf(address(this));
    }

    function _prepareReturn(uint256 _debtOutstanding)
        internal
        view
        override
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

    function _adjustPosition(uint256 _debtOutstanding) internal override {
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

    function _prepareMigration(address _newStrategy) internal override {
        // Nothing needed here because no additional tokens/tokenized positions for mock
    }

    function _protectedTokens() internal override pure returns (address[] memory) {
        return new address[](0); // No additional tokens/tokenized positions for mock
    }

    function expectedReturn() external view returns (uint256) {
        uint256 estimateAssets = estimatedTotalAssets();

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

    function ammCheck(address _start, uint256 _minAmount) external view override returns (bool) {
        return ammStatus;
    }
}
