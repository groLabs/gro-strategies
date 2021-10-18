// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.6;

library Math {
    /// @notice Returns the largest of ers
    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a >= b ? a : b;
    }

    /// @notice Returns the smallest of two numbers
    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice Returns the average of two numbers. The result is rounded towards zero.
    function average(uint256 a, uint256 b) internal pure returns (uint256) {
        // (a + b) / 2 can overflow, so we distribute
        return (a / 2) + (b / 2) + (((a % 2) + (b % 2)) / 2);
    }
}

contract Constants {
    uint8 public constant N_COINS = 3;
    uint8 public constant DEFAULT_DECIMALS = 18; // GToken and Controller use this decimals
    uint256 public constant DEFAULT_DECIMALS_FACTOR = uint256(10)**DEFAULT_DECIMALS;
    uint8 public constant CHAINLINK_PRICE_DECIMALS = 8;
    uint256 public constant CHAINLINK_PRICE_DECIMAL_FACTOR = uint256(10)**CHAINLINK_PRICE_DECIMALS;
    uint8 public constant PERCENTAGE_DECIMALS = 4;
    uint256 public constant PERCENTAGE_DECIMAL_FACTOR = uint256(10)**PERCENTAGE_DECIMALS;
    uint256 public constant CURVE_RATIO_DECIMALS = 6;
    uint256 public constant CURVE_RATIO_DECIMALS_FACTOR = uint256(10)**CURVE_RATIO_DECIMALS;
}

/* @notice AHv2Farmer - Alpha Homora V2 yield aggregator strategy
 *
 *      Farming AHv2 Stable/ETH positions.
 *
 *  ###############################################
 *      Strategy overview
 *  ###############################################
 * 
 *  Gro Protocol Alpha Homora v2 impermanent loss strategy
 * 
 *  Alpha homora (referred to as AHv2) offers leveraged yield farming by offering up to 7x leverage
 *      on users positions in various AMMs. The gro alpha homora v2 strategy (referred to as the strategy)
 *      aim to utilize AHv2 leverage to create and maintain market neutral positions (2x leverage) 
 *      for as long as they are deemed profitable. This means that the strategy will supply want (stable coin) 
 *      to AH, and borrow eth in a proportional amount. Under certian circumstances the strategy will stop
 *      it's borrowing, but will not ever attempt to borrow want from AH.
 * 
 *  ###############################################
 *      Strategy specifications
 *  ###############################################
 * 
 *  The strategy sets out to fulfill the following requirements:
 *      - Open new positions
 *  - Close active positions
 *  - Adjust active positions
 *  - Interact with Gro vault adapters (GVA):
 *          - Report gains/losses
 *      - Borrow assets from GVA to invest into AHv2
 *          - Repay debts to GVA
 *              - Accommodate withdrawals from GVA
 *
 * The strategy keeps track of the following:
 *   - Price changes in opening position
 *   - Collateral ratio of AHv2 position
 *
 * If any of these go out of a preset threshold, the strategy will attempt to close down the position. 
 *      If the collateral factor move away from the ideal target, the strategy won't take on more debt 
 *      from alpha homora when adding assets to the position.
 */
contract AHv2Farmer is Constants {

    event Assertion(uint256, uint256, uint256);
    event Inputs(uint256 _amountNeeded, uint64 _increaseAfterSelling, uint64 _increaseAfterClosing, uint256 _vaultDebtOutstanding, uint256 _calcEstimatedWant);

    // strategies current position
    uint256 public activePosition;
    uint256 public wantBalance;
    bool tested = false;

    // !!!Change these to constant values - these are left as non constant for testing purposes!!!
    int256 public targetCollateralRatio = 7950; // ideal collateral ratio
    int256 public collateralThreshold = 8900; // max collateral raio
    int256 public collateralFactor = 1;

    function inputBalance(uint128 _wantBalance) public {
        wantBalance = _wantBalance;
    }
 
    function inputPosition(uint8 _activePosition) public {
        activePosition = _activePosition;
    } 

    function inputCollateralFactor(int32 _collateralFactor) public {
        if (_collateralFactor < 0)
            _collateralFactor = -_collateralFactor;

        collateralFactor = int256(_collateralFactor);
    } 

    function test(uint128 _amountNeeded, uint64 _increaseAfterSelling, uint64 _increaseAfterClosing, uint256 _vaultDebtOutstanding, uint128 _calcEstimatedWant) public {
       if (_amountNeeded == 0)
         return;

       if (_vaultDebtOutstanding > 103 * (_calcEstimatedWant + wantBalance) / 100)
         _vaultDebtOutstanding = _vaultDebtOutstanding % (103 * (_calcEstimatedWant + wantBalance) / 100); 

       try this.liquidatePosition(_amountNeeded, _increaseAfterSelling, _increaseAfterClosing, _vaultDebtOutstanding, _calcEstimatedWant) returns (uint256 _liquidatedAmount, uint256 _loss) {
         emit Inputs(_amountNeeded, _increaseAfterSelling, _increaseAfterClosing, _vaultDebtOutstanding, _calcEstimatedWant);
         emit Assertion(_liquidatedAmount, _loss, _amountNeeded);
         assert(_liquidatedAmount + _loss <= _amountNeeded);
       } catch { assert(false); }
    } 
 

    /*
     * @notice partially removes or closes the current AH v2 position in order to repay a requested amount
     * @param _amountNeeded amount needed to be withdrawn from strategy
     */
    function liquidatePosition(uint256 _amountNeeded, uint64 _increaseAfterSelling, uint64 _increaseAfterClosing, uint256 _vaultDebtOutstanding, uint256 _calcEstimatedWant)
        external
        returns (uint256, uint256)
    {
        uint256 _amountFreed = 0;
        uint256 _loss = 0;
        // want in contract + want value of position based of eth value of position (total - borrowed)
        uint256 _positionId = activePosition;

        uint256 assets = _calcEstimatedWant; 
        uint256 _balance = wantBalance; // _estimatedTotalAssets(_positionId);

        uint256 debt = _vaultDebtOutstanding;// vault.strategyDebt();

        // cannot repay the entire debt
        if(debt > assets) {
            _loss = debt - assets;
            if (_loss >= _amountNeeded) {
                _loss = _amountNeeded;
                _amountFreed = 0;
                return (_amountFreed, _loss);
            }
            _amountNeeded = _amountNeeded - _loss;
        }

        // if the asset value of our position is less than what we need to withdraw, close the position
        if (assets < _amountNeeded) {
            if (activePosition != 0) {
                // closePosition(_positionId, false);
                _balance = _balance + _increaseAfterClosing;
            }
            // sellEth(false);
            // sellSushi(false);
            _balance = _balance + _increaseAfterSelling;
            _amountFreed = Math.min(_amountNeeded, _balance);
        } else {
            // do we have enough assets in strategy to repay?
            int256 changeFactor = collateralFactor - targetCollateralRatio; // getCollateralFactor(_positionId) - targetCollateralRatio;
            if (_balance < _amountNeeded) {
                uint256 remainder;
                if (changeFactor > 500) {
                    // closePosition(_positionId, false);
                    _balance = _balance + _increaseAfterClosing;
                    _amountFreed = Math.min(_amountNeeded, _balance);
                    return (_amountFreed, _loss);
                }
                // because pulling out assets from AHv2 tends to give us less assets than
                // we want specify, so lets see if we can pull out a bit in excess to be
                // able to pay back the full amount
                if(assets > _amountNeeded - _balance / 2) {
                    remainder = _amountNeeded - _balance / 2;
                } else {
                    // but if not possible just pull the original amount
                    remainder = _amountNeeded - _balance;
                }

                // if we want to remove 80% or more of the position, just close it
                if (remainder * PERCENTAGE_DECIMAL_FACTOR / assets >= 8000) {
                    // closePosition(_positionId, false);
                    _balance = _balance + _increaseAfterClosing;
                } else {
                    // _withdrawSome(_positionId, remainder);
                    _balance = _balance + _increaseAfterClosing;
                }

                // dont return more than was asked for
                _amountFreed = Math.min(_amountNeeded, _balance);
            }else{
                _amountFreed = _amountNeeded;
            }
            return (_amountFreed, _loss);
        }
    }

}
