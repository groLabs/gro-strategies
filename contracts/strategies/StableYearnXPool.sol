// SPDX-License-Identifier: AGPLv3
pragma solidity >=0.6.0 <0.7.0;
pragma experimental ABIEncoderV2;

import "contracts/interfaces/IVault.sol";
import "contracts/common/Whitelist.sol";
import {ICurveMetaPool} from "contracts/interfaces/ICurve.sol";
import "contracts/interfaces/IERC20Detailed.sol";
import "../BaseStrategy.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

/// @notice Yearn V2 vault interface
interface V2YVault {
    function deposit(uint256 _amount) external;

    function deposit() external;

    function withdraw(uint256 maxShares) external;

    function withdraw() external;

    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    function transfer(address recipient, uint256 amount) external returns (bool);

    function pricePerShare() external view returns (uint256);

    function token() external view returns (address);
}

library Math {
    /// @notice Returns the largest of two numbers
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
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    IERC20 public lpToken = IERC20(address(0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490)); // Meta lp token (MLP)
    // Default Curve metapool
    address public curve = address(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
    // Default yearn vault
    V2YVault public yVault = V2YVault(address(0x84E13785B5a27879921D6F685f041421C7F482dA));
    // Index of 3crv token in metapool
    int128 wantIndex = 1;
    // Number of tokens in metapool (+1 Stablecoin, 3Crv)
    uint256 constant META_NO = 2;
    uint256 constant DECIMALS = 18;
    uint256 constant PERCENT = 10000;

    uint256 public minBP = 9995; // minAmount for curve pool interactions, defaults to 5 bp
    uint256 public difference; // initial difference between estimate and debt on investment

    // Curve meta pool to migrate to
    address public prepCurve;
    // Yearn vault to migrate to
    address public prepYVault;
    bool public tendLock;

    event LogNewMigration(address indexed yVault, address indexed curve, address lpToken);
    event LogNewMigrationPreperation(address indexed yVault, address indexed curve);
    event LogForceMigration(bool status);
    event LogMigrationCost(int256 cost);

    constructor(address _vault) public BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        tendLock = true;
        require(keccak256(bytes(apiVersion())) == keccak256(bytes(VaultAPI(_vault).apiVersion())), "WRONG VERSION");
    }

    /// @notice Set migration targets
    /// @param _yVault Target Yearn vault
    /// @param _curve Target Curve meta pool
    function setMetaPool(address _yVault, address _curve) external onlyAuthorized {
        prepYVault = _yVault;
        prepCurve = _curve;
        emit LogNewMigrationPreperation(_yVault, _curve);
    }

    function name() external view override returns (string memory) {
        return "StrategyCurveXPool";
    }

    /// @notice Force the pool to migrate, allows to trigger tend no matter the circumstances
    ///     - Warning this will very likely result in a loss of assets as yearn v1 vaults have
    ///         a 50 BP withdrawal fee on anything above the assets available in the vault
    function forceTend() external onlyOwner {
        tendLock = true;
        emit LogForceMigration(true);
    }

    function resetDifference() external onlyOwner {
        difference = 0;
    }

    function setMinAmount(uint256 _minBP) external onlyOwner {
        minBP = _minBP;
    }

    /// @notice Get the total assets of this strategy.
    ///     This method is only used to pull out debt if debt ratio has changed.
    /// @return Total assets in want this strategy has invested into underlying vault
    function estimatedTotalAssets() public view override returns (uint256) {
        return _estimatedTotalAssets(true);
    }

    /// @notice Expected returns from strategy (gains from pool swaps)
    function expectedReturn() public view returns (uint256) {
        return _expectedReturn();
    }

    function _expectedReturn() private view returns (uint256) {
        uint256 estimateAssets = _estimatedTotalAssets(true);
        uint256 debt = vault.strategies(address(this)).totalDebt;
        if (debt > estimateAssets) {
            return 0;
        } else {
            return estimateAssets - debt;
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
        _debtPayment = _debtOutstanding;
        uint256 lentAssets = convertToUnderlying(yVault.balanceOf(address(this)));
        uint256 looseAssets = want.balanceOf(address(this));
        uint256 total = looseAssets.add(lentAssets);

        if (lentAssets == 0) {
            // No position to harvest or profit to report
            if (_debtPayment > looseAssets) {
                // We can only return looseAssets
                _debtPayment = looseAssets;
            }

            return (_profit, _loss, _debtPayment);
        }

        uint256 debt = vault.strategies(address(this)).totalDebt;

        if (total > debt) {
            _profit = total - debt;
            uint256 amountToFree = _profit.add(_debtPayment);
            if (amountToFree > 0 && looseAssets < amountToFree) {
                // Withdraw what we can withdraw
                _withdrawSome(amountToFree.sub(looseAssets));
                uint256 newLoose = want.balanceOf(address(this));

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
            // Serious issue - A loss should never happen but if it does lets record it accurately
            _loss = debt - total;
            uint256 amountToFree = _debtPayment;

            if (amountToFree > 0 && looseAssets < amountToFree) {
                // Withdraw what we can withdraw

                _withdrawSome(amountToFree.sub(looseAssets));
                uint256 newLoose = want.balanceOf(address(this));

                if (newLoose < amountToFree) {
                    _debtPayment = newLoose;
                }
            }
        }
    }

    /// @notice Withdraw amount from yVault/pool
    /// @param _amount Expected amount to withdraw
    function _withdrawSome(uint256 _amount) internal returns (uint256) {
        uint256 amountInYtokens = convertFromUnderlying(_amount);
        uint256 amountInLpTokens = amountInYtokens.mul(yVault.pricePerShare()).div(uint256(10)**DECIMALS);

        uint256 yBalance = yVault.balanceOf(address(this));

        ICurveMetaPool _curve = ICurveMetaPool(curve);

        uint256 balanceBefore = want.balanceOf(address(this));

        if (amountInYtokens == 0) {
            return 0;
        }

        if (amountInYtokens > yBalance) {
            // Can't withdraw more than we own
            yVault.withdraw(yBalance);
            uint256 metaBalance = lpToken.balanceOf(address(this));
            if (amountInLpTokens > metaBalance) {
                amountInLpTokens = metaBalance;
            }
        } else {
            yVault.withdraw(amountInYtokens);
        }

        uint256 tokenAmonut = _curve.calc_withdraw_one_coin(amountInLpTokens, wantIndex);
        uint256 minAmount = tokenAmonut.mul(minBP).div(PERCENT);
        _curve.remove_liquidity_one_coin(amountInLpTokens, wantIndex, minAmount);
        uint256 newBalance = want.balanceOf(address(this));

        return newBalance.sub(balanceBefore);
    }

    /// @notice Used when emergency stop has been called to empty out strategy
    /// @param _amountNeeded Expected amount to withdraw
    function liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _liquidatedAmount, uint256 _loss)
    {
        _loss; // We should not be able to make a loss here

        uint256 looseAssets = want.balanceOf(address(this));

        if (looseAssets < _amountNeeded) {
            _withdrawSome(_amountNeeded - looseAssets);
        }

        _liquidatedAmount = Math.min(_amountNeeded, want.balanceOf(address(this)));
    }

    /// @notice Used to invest any assets sent from the vault during report
    /// @param _debtOutstanding Should always be 0 at this point
    function adjustPosition(uint256 _debtOutstanding) internal override {
        if (tendLock) {
            tendLock = false;
            migrate();
        }
        uint256 _wantBal = want.balanceOf(address(this));
        if (_wantBal > 0) {
            ICurveMetaPool _curve = ICurveMetaPool(curve);
            uint256[META_NO] memory tokenAmounts;
            tokenAmounts[uint256(wantIndex)] = _wantBal;

            uint256 minAmount = _curve.calc_token_amount(tokenAmounts, true);
            minAmount = minAmount.mul(minBP).div(PERCENT);

            _curve.add_liquidity(tokenAmounts, minAmount);
            uint256 lpBalance = lpToken.balanceOf(address(this));
            yVault.deposit(lpBalance);
        }
        uint256 debt = vault.strategies(address(this)).totalDebt;
        uint256 _estimate = _estimatedTotalAssets(false);
        if (debt > _estimate) {
            difference = debt.sub(_estimate);
        } else {
            difference = 0;
        }
    }

    function hardMigration() external onlyAuthorized() {
        prepareMigration(address(vault));
        want.safeTransfer(address(vault), want.balanceOf(address(this)));
    }

    /// @notice Prepare for migration by transfering tokens
    function prepareMigration(address _newStrategy) internal override {
        yVault.withdraw();
        ICurveMetaPool _curve = ICurveMetaPool(curve);

        uint256 lpBalance = lpToken.balanceOf(address(this));
        uint256 tokenAmonut = _curve.calc_withdraw_one_coin(lpBalance, wantIndex);
        uint256 minAmount = tokenAmonut.mul(minBP).div(PERCENT);
        _curve.remove_liquidity_one_coin(lpBalance, wantIndex, minAmount);
        uint256 looseAssets = want.balanceOf(address(this));
    }

    /// @notice Tokens protected by strategy - want tokens are protected by default
    function protectedTokens() internal view override returns (address[] memory) {
        address[] memory protected = new address[](1);
        protected[1] = address(yVault);
        protected[2] = address(lpToken);
        return protected;
    }

    /// @notice Migrate to new metapool
    function migrate() private {
        uint256 initialBalance = _estimatedTotalAssets(false);
        if (yVault.balanceOf(address(this)) > 0) {
            migrateWant();
        }
        migrateYearn(prepYVault, prepCurve);
        uint256 finalBalance = _estimatedTotalAssets(false);
        emit LogNewMigration(prepYVault, prepCurve, address(lpToken));
        emit LogMigrationCost(int256(initialBalance) - int256(finalBalance));
        emit LogForceMigration(tendLock);
        prepCurve = address(0);
        prepYVault = address(0);
    }

    /// @notice Migrate Yearn vault
    /// @param _prepYVault Target Yvault
    /// @param _prepCurve Target Curve meta pool
    function migrateYearn(address _prepYVault, address _prepCurve) private {
        V2YVault _yVault = V2YVault(_prepYVault); // Set the yearn vault for this strategy
        curve = _prepCurve;
        yVault = _yVault;
        lpToken = IERC20(_yVault.token());
        if (lpToken.allowance(address(this), _prepYVault) == 0) {
            lpToken.safeApprove(_prepYVault, uint256(-1));
        }
        if (want.allowance(address(this), _prepCurve) == 0) {
            want.safeApprove(_prepCurve, uint256(-1));
        }
    }

    /// @notice Pull out any invested funds before migration
    function migrateWant() private {
        yVault.withdraw();
        ICurveMetaPool _curve = ICurveMetaPool(curve);

        uint256 lpBalance = lpToken.balanceOf(address(this));
        uint256 tokenAmonut = _curve.calc_withdraw_one_coin(lpBalance, wantIndex);
        uint256 minAmount = tokenAmonut.mul(minBP).div(PERCENT);

        _curve.remove_liquidity_one_coin(lpToken.balanceOf(address(this)), wantIndex, minAmount);
    }

    /// @notice Estimated total assets of strategy
    /// @param diff Calc token amounts (curve) underreports total amount, to counteract this
    ///     we add initial difference from last harvest to estimated total assets,
    function _estimatedTotalAssets(bool diff) private view returns (uint256) {
        uint256 amount = yVault.balanceOf(address(this)).mul(yVault.pricePerShare()).div(uint256(10)**DECIMALS);
        amount = amount.add(lpToken.balanceOf(address(this))); 
        uint256 estimated;
        if (amount > 0) {
            estimated = ICurveMetaPool(curve).calc_withdraw_one_coin(amount, wantIndex);
        }
        estimated = estimated.add(want.balanceOf(address(this)));
        if (diff) {
            return estimated.add(difference);
        } else {
            return estimated;
        }
    }

    /// @notice Convert ytokens to want
    /// @param amountOfTokens Amount to convert
    function convertToUnderlying(
        uint256 amountOfTokens
    ) private view returns (uint256 balance) {
        if (amountOfTokens == 0) {
            balance = 0;
        } else {
            uint256 lpAmount = amountOfTokens.mul(yVault.pricePerShare()).div(uint256(10)**DECIMALS);
            balance = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, wantIndex);
        }
    }

    /// @notice Convert want to ytokens
    /// @param amountOfUnderlying Amount to convert
    function convertFromUnderlying(
        uint256 amountOfUnderlying
    ) private view returns (uint256 balance) {
        if (amountOfUnderlying == 0) {
            balance = 0;
        } else {
            uint256 lpAmount = wantToLp(amountOfUnderlying);
            balance = lpAmount.mul(uint256(10)**DECIMALS).div(yVault.pricePerShare());
        }
    }

    /// @notice Convert want token to LP meta pool token
    /// @param amount Amount to convert
    function wantToLp(uint256 amount) private view returns (uint256) {
        uint256[META_NO] memory tokenAmounts;
        tokenAmounts[uint256(wantIndex)] = amount;

        return ICurveMetaPool(curve).calc_token_amount(tokenAmounts, true);
    }
}
