// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../BaseStrategy.sol";
import "../interfaces/ICurve.sol";
import "../common/Constants.sol";

/// @notice Yearn V2 vault interface
interface V2YVault {
    function deposit(uint256 _amount) external;

    function deposit() external;

    function withdraw(uint256 maxShares) external returns (uint256);

    function withdraw() external returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function transfer(address recipient, uint256 amount) external returns (bool);

    function pricePerShare() external view returns (uint256);

    function token() external view returns (address);
}

/// @notice Yearn curve Metapool strategy
///     Deposit stablecoins into Curve metapool - deposit received metapool tokens
///     to Yearn vault. Harvest only repays debts and pull available credit from vault.
///     This strategy can migrate between metapools and yearn vaults, and requires that
///     a new metapool and yearn vault get set and tend run. Theres a 0.5% withdrawal fee on this strategy,
///     this means that there should be a 0.5% buffer on assets before migrating in order,
///     for this strategy not to generate any loss.
///     ########################################
///     Strategy breakdown
///     ########################################
///
///     Want: 3Crv
///     Additional tokens: MetaPoolLP token (Curve), YMetaPoolVault token (yearn)
///     Exposures:
///         Protocol: Curve, Yearn, +1 stablecoin from metapool
///         stablecoins: DAI, USDC, USDT +1 stablecoin from metapool
///     Debt ratio set to 100% - should be only strategy in curveVault
///
///     Strategy logic:
///         Vault => Loan out 3Crv into strategy
///             strategy => invest 3Crv into target Curve meta pool
///                      <= get metapool tokens (MLP) in return
///             strategy => invest MLP into yearn YMetaPoolVault
///                      <= get Yshares in return
///
///         Harvest: Report back gains/losses to vault:
///                     - do not withdraw any assets from Yearn/metapool
///                     - do pull and invest any new 3crv available in vault
///
///         Migrate metapool: Move assets from one metapool to another:
///                     - Set new target metapool/Yearn vault
///                     - Ensure that current gains cover withdrawal fee (Yearn)
///                     - Strategy withdraw assetse down to 3Crv tokens and
///                         redeploys into new metapool/yearn vault
///
///         Tend: Withdraw available assets from yearn without getting hit by a fee
///                 Used to redistribute 3Crv tokens into stablecoins
///                 - see lifeguards, distributeCurveVault function
contract StableYearnXPool is BaseStrategy {
    using SafeERC20 for IERC20;

    IERC20 public lpToken; // Meta lp token (MLP)
    // Default Curve metapool
    address public curve = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
    // Default yearn vault
    V2YVault public yVault = V2YVault(address(0x84E13785B5a27879921D6F685f041421C7F482dA));
    // Index of 3crv token in metapool
    int128 wantIndex = 1;
    // Number of tokens in metapool (+1 Stablecoin, 3Crv)
    uint256 constant metaPool = 2;
    uint256 constant PERCENTAGE_DECIMAL_FACTOR = 10000;
    uint256 public decimals = 18;
    int256 public difference = 0;

    // Curve meta pool to migrate to
    address public prepCurve = address(0);
    // Yearn vault to migrate to
    address public prepYVault = address(0);

    event LogNewMigration(address indexed yVault, address indexed curve, address lpToken);
    event LogNewMigrationPreperation(address indexed yVault, address indexed curve);
    event LogForceMigration(bool status);
    event LogMigrationCost(int256 cost);

    constructor(address _vault) public BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        lpToken = want;
    }

    /// @notice Set migration targets
    /// @param _yVault Target Yearn vault
    /// @param _curve Target Curve meta pool
    function setMetaPool(address _yVault, address _curve) external onlyOwner {
        prepYVault = _yVault;
        prepCurve = _curve;

        emit LogNewMigrationPreperation(_yVault, _curve);
    }

    function name() external view override returns (string memory) {
        return "StrategyCurveXPool";
    }

    function resetDifference() external onlyOwner {
        difference = 0;
    }

    /// @notice Get the total assets of this strategy.
    ///     This method is only used to pull out debt if debt ratio has changed.
    /// @return Total assets in want this strategy has invested into underlying vault
    function estimatedTotalAssets() public view override returns (uint256) {
        (uint256 estimatedAssets, ) = _estimatedTotalAssets(true);
        return estimatedAssets;
    }

    /// @notice Expected returns from strategy (gains from pool swaps)
    function expectedReturn() public view returns (uint256) {
        return _expectedReturn();
    }

    function _expectedReturn() private view returns (uint256) {
        (uint256 estimatedAssets, ) = _estimatedTotalAssets(true);
        uint256 debt = vault.strategies(address(this)).totalDebt;
        if (debt > estimatedAssets) {
            return 0;
        } else {
            return estimatedAssets - debt;
        }
    }

    /// @notice This strategy doesn't realize profit outside of APY from the vault.
    ///     This method is only used to pull out debt if debt ratio has changed.
    /// @param _debtOutstanding Debt to pay back
    function prepareReturn(uint256 _debtOutstanding)
        internal
        override
        returns (
            uint256 _profit,
            uint256 _loss,
            uint256 _debtPayment
        )
    {
        uint256 lentAssets = 0;
        _debtPayment = _debtOutstanding;
        address _prepCurve = prepCurve;
        address _prepYVault = prepYVault;
        uint256 looseAssets;
        if (_prepCurve != address(0) && _prepYVault != address(0)) {
            migratePool(_prepCurve, _prepYVault);
        }
        (lentAssets, looseAssets) = _estimatedTotalAssets(false);
        uint256 debt = vault.strategies(address(this)).totalDebt;

        if (lentAssets - looseAssets == 0) {
            _debtPayment = Math.min(looseAssets, _debtPayment);

            return (_profit, _loss, _debtPayment);
        }

        if (lentAssets > debt) {
            _profit = lentAssets - debt;
            uint256 amountToFree = _profit + (_debtPayment);
            if (amountToFree > 0 && looseAssets < amountToFree) {
                // Withdraw what we can withdraw
                uint256 newLoose = _withdrawSome(amountToFree, looseAssets);

                // If we don't have enough money adjust _debtOutstanding and only change profit if needed
                if (newLoose < amountToFree) {
                    if (_profit > newLoose) {
                        _profit = newLoose;
                        _debtPayment = 0;
                    } else {
                        _debtPayment = Math.min(newLoose - _profit, _debtPayment);
                    }
                }
            }
        } else {
            if (_debtPayment == debt) {
                _withdrawSome(debt, looseAssets);
                _debtPayment = want.balanceOf(address(this));
                if (_debtPayment > debt) {
                    _profit = _debtPayment - debt;
                } else {
                    _loss = debt - _debtPayment;
                }
            } else {
                _loss = debt - lentAssets;
                uint256 amountToFree = _debtPayment;
                if (amountToFree > 0 && looseAssets < amountToFree) {
                    // Withdraw what we can withdraw
                    _debtPayment = _withdrawSome(amountToFree, looseAssets);
                }
            }
        }
    }

    /// @notice Withdraw amount from yVault/pool
    /// @param _amountToFree Expected amount needed
    /// @param _loose want balance of contract
    function _withdrawSome(uint256 _amountToFree, uint256 _loose) internal returns (uint256) {
        uint256 _amount = _amountToFree - _loose;
        uint256 yBalance = yVault.balanceOf(address(this));
        uint256 lpBalance = lpToken.balanceOf(address(this));

        if (yBalance > 0) {
            // yVault calc are not precise, better to pull out more than needed
            uint256 _amount_buffered = (_amount * (PERCENTAGE_DECIMAL_FACTOR + 500)) / PERCENTAGE_DECIMAL_FACTOR;
            uint256 amountInYtokens = convertFromUnderlying(_amount_buffered, decimals, wantIndex);
            if (amountInYtokens > yBalance) {
                // Can't withdraw more than we own
                amountInYtokens = yBalance;
            }
            uint256 yValue = yVault.withdraw(amountInYtokens);
            lpBalance += yValue;
        }
        ICurveMetaPool _curve = ICurveMetaPool(curve);
        uint256 tokenAmount = _curve.calc_withdraw_one_coin(lpBalance, wantIndex);
        uint256 minAmount = tokenAmount - ((tokenAmount * (9995)) / (10000));

        _curve.remove_liquidity_one_coin(lpBalance, wantIndex, minAmount);

        return Math.min(_amountToFree, want.balanceOf(address(this)));
    }

    /// @notice Used when emergency stop has been called to empty out strategy
    /// @param _amountNeeded Expected amount to withdraw
    function liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _liquidatedAmount, uint256 _loss)
    {
        uint256 looseAssets = want.balanceOf(address(this));

        if (looseAssets < _amountNeeded) {
            _liquidatedAmount = _withdrawSome(_amountNeeded, looseAssets);
        } else {
            _liquidatedAmount = Math.min(_amountNeeded, looseAssets);
        }
        _loss = _amountNeeded - _liquidatedAmount;
        calcDifference(_loss);
    }

    /// @notice Used to invest any assets sent from the vault during report
    /// @param _debtOutstanding outstanding debt
    function adjustPosition(uint256 _debtOutstanding) internal override {
        uint256 _wantBal = want.balanceOf(address(this));
        if (_wantBal > _debtOutstanding) {
            ICurveMetaPool _curve = ICurveMetaPool(curve);
            uint256[metaPool] memory tokenAmounts;
            tokenAmounts[uint256(int256(wantIndex))] = _wantBal;

            uint256 minAmount = _curve.calc_token_amount(tokenAmounts, true);
            minAmount = minAmount - ((minAmount * (9995)) / (10000));

            _curve.add_liquidity(tokenAmounts, minAmount);
            uint256 lpBalance = lpToken.balanceOf(address(this));
            yVault.deposit(lpBalance);
        }
        calcDifference(0);
    }

    function calcDifference(uint256 _loss) internal {
        uint256 debt = vault.strategies(address(this)).totalDebt;
        // shouldnt be possible
        if (_loss > debt) debt = 0;
        if (_loss > 0) debt = debt - _loss;
        (uint256 _estimate, ) = _estimatedTotalAssets(false);
        if (debt != _estimate) {
            difference = int256(debt) - int256(_estimate);
        } else {
            difference = 0;
        }
    }

    function hardMigration() external onlyOwner {
        prepareMigration(address(vault));
    }

    /// @notice Prepare for migration by transfering tokens
    function prepareMigration(address _newStrategy) internal override {
        yVault.withdraw();
        ICurveMetaPool _curve = ICurveMetaPool(curve);

        uint256 lpBalance = lpToken.balanceOf(address(this));
        uint256 tokenAmonut = _curve.calc_withdraw_one_coin(lpBalance, wantIndex);
        uint256 minAmount = tokenAmonut - ((tokenAmonut * (9995)) / (10000));
        _curve.remove_liquidity_one_coin(lpToken.balanceOf(address(this)), wantIndex, minAmount);
        uint256 looseAssets = want.balanceOf(address(this));
        want.safeTransfer(_newStrategy, looseAssets);
    }

    /// @notice Tokens protected by strategy - want tokens are protected by default
    function protectedTokens() internal view override returns (address[] memory) {
        address[] memory protected = new address[](1);
        protected[1] = address(yVault);
        protected[2] = address(lpToken);
        return protected;
    }

    /// @notice Migrate to new metapool
    function migratePool(address _prepCurve, address _prepYVault) private {
        if (yVault.balanceOf(address(this)) > 0) {
            migrateWant();
        }
        address _lpToken = migrateYearn(_prepYVault, _prepCurve);
        emit LogNewMigration(_prepYVault, _prepCurve, _lpToken);
        prepCurve = address(0);
        prepYVault = address(0);
    }

    /// @notice Migrate Yearn vault
    /// @param _prepYVault Target Yvault
    /// @param _prepCurve Target Curve meta pool
    function migrateYearn(address _prepYVault, address _prepCurve) private returns (address) {
        yVault = V2YVault(_prepYVault); // Set the yearn vault for this strategy
        curve = _prepCurve;
        address _lpToken = yVault.token();
        lpToken = IERC20(_lpToken);
        if (lpToken.allowance(address(this), _prepYVault) == 0) {
            lpToken.safeApprove(_prepYVault, type(uint256).max);
        }
        if (want.allowance(address(this), _prepCurve) == 0) {
            want.safeApprove(_prepCurve, type(uint256).max);
        }
        return _lpToken;
    }

    /// @notice Pull out any invested funds before migration
    function migrateWant() private returns (bool) {
        yVault.withdraw();
        ICurveMetaPool _curve = ICurveMetaPool(curve);

        uint256 lpBalance = lpToken.balanceOf(address(this));
        uint256 tokenAmonut = _curve.calc_withdraw_one_coin(lpBalance, wantIndex);
        uint256 minAmount = tokenAmonut - ((tokenAmonut * (9995)) / (10000));

        _curve.remove_liquidity_one_coin(lpToken.balanceOf(address(this)), wantIndex, minAmount);
        return true;
    }

    /// @notice Estimated total assets of strategy
    /// @param diff Calc token amounts (curve) underreports total amount, to counteract this
    ///     we add initial difference from last harvest to estimated total assets,
    function _estimatedTotalAssets(bool diff) private view returns (uint256, uint256) {
        uint256 amount = (yVault.balanceOf(address(this)) * (yVault.pricePerShare())) / (uint256(10)**decimals);
        amount += lpToken.balanceOf(address(this));
        uint256 estimated = 0;
        if (amount > 0) {
            estimated = ICurveMetaPool(curve).calc_withdraw_one_coin(amount, wantIndex);
        }
        uint256 balance = want.balanceOf(address(this));
        estimated += balance;
        if (diff) {
            if (difference > int256(estimated)) return (balance, balance);
            return (uint256(int256(estimated) + (difference)), balance);
        } else {
            return (estimated, balance);
        }
    }

    /// @notice Convert ytokens to want
    /// @param amountOfTokens Amount to convert
    function convertToUnderlying(
        uint256 amountOfTokens,
        uint256 _decimals,
        int128 index
    ) private view returns (uint256 balance) {
        if (amountOfTokens == 0) {
            balance = 0;
        } else {
            uint256 lpAmount = (amountOfTokens * (yVault.pricePerShare())) / (uint256(10)**_decimals);
            balance = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, index);
        }
    }

    /// @notice Convert want to ytokens
    /// @param amountOfUnderlying Amount to convert
    function convertFromUnderlying(
        uint256 amountOfUnderlying,
        uint256 _decimals,
        int128 index
    ) private view returns (uint256 balance) {
        if (amountOfUnderlying == 0) {
            balance = 0;
        } else {
            uint256 lpAmount = wantToLp(amountOfUnderlying, index);
            balance = (lpAmount * (uint256(10)**_decimals)) / (yVault.pricePerShare());
        }
    }

    /// @notice Convert want token to LP meta pool token
    /// @param amount Amount to convert
    function wantToLp(uint256 amount, int128 index) private view returns (uint256) {
        uint256[metaPool] memory tokenAmounts;
        tokenAmounts[uint256(int256(index))] = amount;

        return ICurveMetaPool(curve).calc_token_amount(tokenAmounts, true);
    }

    function tendTrigger(uint256 callCost) public view override returns (bool) {
        return false;
    }
}
