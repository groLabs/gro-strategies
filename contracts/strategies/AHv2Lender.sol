// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../BaseStrategy.sol";

interface ISafeBox is IERC20 {
    function cToken() external returns (address);

    function uToken() external returns (address);

    function deposit(uint256 amount) external;

    function withdraw(uint256 amount) external;

    function claim(uint256 totalReward, bytes32[] memory proof) external;
}

interface CTokenI {
    function transfer(address dst, uint256 amount) external returns (bool);

    function transferFrom(
        address src,
        address dst,
        uint256 amount
    ) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function balanceOfUnderlying(address owner) external returns (uint256);

    function symbol() external view returns (string memory);

    function getAccountSnapshot(address account)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256
        );

    function borrowRatePerBlock() external view returns (uint256);

    function supplyRatePerBlock() external view returns (uint256);

    function totalBorrowsCurrent() external returns (uint256);

    function borrowBalanceCurrent(address account) external returns (uint256);

    function borrowBalanceStored(address account) external view returns (uint256);

    function exchangeRateCurrent() external returns (uint256);

    function accrualBlockNumber() external view returns (uint256);

    function exchangeRateStored() external view returns (uint256);

    function getCash() external view returns (uint256);

    function accrueInterest() external returns (uint256);

    function totalReserves() external view returns (uint256);

    function reserveFactorMantissa() external view returns (uint256);

    function seize(
        address liquidator,
        address borrower,
        uint256 seizeTokens
    ) external returns (uint256);

    function totalBorrows() external view returns (uint256);

    function totalSupply() external view returns (uint256);
}

interface CErc20I is CTokenI {
    function mint(uint256 mintAmount) external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);

    function borrow(uint256 borrowAmount) external returns (uint256);

    function repayBorrow(uint256 repayAmount) external returns (uint256);

    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256);

    function liquidateBorrow(
        address borrower,
        uint256 repayAmount,
        CTokenI cTokenCollateral
    ) external returns (uint256);

    function underlying() external view returns (address);
}

// Uniswap router interface
interface IUni {
    function getAmountsOut(uint256 _amountIn, address[] calldata _path)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 _amountIn,
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    ) external returns (uint256[] memory amounts);

    function swapExactAVAXForTokens(
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    ) external payable returns (uint256[] memory amounts);
}

contract AHLender is BaseStrategy {
    using SafeERC20 for IERC20;

    ISafeBox public safeBox;
    CErc20I public crToken;

    address public constant avax = address(0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7);
    address public constant alpha = address(0x2147EFFF675e4A4eE1C2f918d181cDBd7a8E208f);

    address public immutable router;

    address[] public path;

    constructor(
        address _vault,
        address _safeBox,
        address _router
    ) public BaseStrategy(_vault) {
        // You can set these parameters on deployment to whatever you want
        // maxReportDelay = 6300;
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        safeBox = ISafeBox(_safeBox);
        router = _router;
        require(address(want) == safeBox.uToken(), "Wrong safebox");
        crToken = CErc20I(safeBox.cToken());

        want.safeApprove(_safeBox, type(uint256).max);

        path = new address[](3);
        path[0] = alpha;
        path[1] = avax;
        path[2] = address(want);
        IERC20(alpha).safeApprove(_router, type(uint256).max);
    }

    function sellAlpha(uint256 amount) public onlyAuthorized {
        IUni(router).swapExactTokensForTokens(amount, 0, path, address(this), block.timestamp);
    }

    function name() external view override returns (string memory) {
        return string(abi.encodePacked("StrategyAH2Earn", crToken.symbol()));
    }

    function claim(uint256 totalReward, bytes32[] memory proof) public onlyAuthorized {
        safeBox.claim(totalReward, proof);
    }

    function estimatedTotalAssets() public view override returns (uint256) {
        return want.balanceOf(address(this)) + convertToUnderlying(safeBox.balanceOf(address(this)));
    }

    function convertToUnderlying(uint256 amountOfTokens) public view returns (uint256 balance) {
        if (amountOfTokens == 0) {
            balance = 0;
        } else {
            balance = (amountOfTokens * crToken.exchangeRateStored()) / 1e18;
        }
    }

    function convertFromUnderlying(uint256 amountOfUnderlying) public view returns (uint256 balance) {
        if (amountOfUnderlying == 0) {
            balance = 0;
        } else {
            balance = (amountOfUnderlying * 1e18) / crToken.exchangeRateStored();
        }
    }

    function _prepareReturn(uint256 _debtOutstanding)
        internal
        override
        returns (
            uint256 _profit,
            uint256 _loss,
            uint256 _debtPayment
        )
    {
        _debtPayment = _debtOutstanding;
        uint256 lentAssets = convertToUnderlying(safeBox.balanceOf(address(this)));

        uint256 looseAssets = want.balanceOf(address(this));

        uint256 total = looseAssets + lentAssets;

        //future sam. this is from gen lender hence the logic of why we would have loose assets and no lent assets
        if (lentAssets == 0) {
            //no position to harvest or profit to report
            if (_debtPayment > looseAssets) {
                //we can only return looseAssets
                _debtPayment = looseAssets;
            }

            return (_profit, _loss, _debtPayment);
        }

        uint256 debt = vault.strategies(address(this)).totalDebt;

        if (total > debt) {
            _profit = total - debt;
            uint256 amountToFree = _profit + _debtPayment;
            if (amountToFree > 0 && looseAssets < amountToFree) {
                //withdraw what we can withdraw
                _withdrawSome(amountToFree - looseAssets);
                uint256 newLoose = want.balanceOf(address(this));

                //if we dont have enough money adjust _debtOutstanding and only change profit if needed
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
            //serious. loss should never happen but if it does lets record it accurately
            _loss = debt - total;
            uint256 amountToFree = _debtPayment;

            if (amountToFree > 0 && looseAssets < amountToFree) {
                //withdraw what we can withdraw

                _withdrawSome(amountToFree - looseAssets);
                uint256 newLoose = want.balanceOf(address(this));

                if (newLoose < amountToFree) {
                    _debtPayment = newLoose;
                }
            }
        }
    }

    function _adjustPosition(uint256 _debtOutstanding) internal override {
        uint256 _toInvest = want.balanceOf(address(this));

        safeBox.deposit(_toInvest);
    }

    //withdraw amount from safebox
    //safe to enter more than we have
    function _withdrawSome(uint256 _amount) internal returns (uint256) {
        uint256 amountInCtokens = convertFromUnderlying(_amount);
        uint256 balanceOfSafebox = safeBox.balanceOf(address(this));

        uint256 balanceBefore = want.balanceOf(address(this));

        if (balanceOfSafebox < 2) {
            return 0;
        }
        balanceOfSafebox = balanceOfSafebox - 1;

        if (amountInCtokens > balanceOfSafebox) {
            //cant withdraw more than we own
            amountInCtokens = balanceOfSafebox;
        }

        //not state changing but OK because of previous call
        uint256 liquidity = want.balanceOf(address(crToken));
        uint256 liquidityInCTokens = convertFromUnderlying(liquidity);

        if (liquidityInCTokens > 2) {
            liquidityInCTokens = liquidityInCTokens - 1;

            if (amountInCtokens <= liquidityInCTokens) {
                //we can take all
                safeBox.withdraw(amountInCtokens);
            } else {
                //redo or else price changes
                crToken.mint(0);
                liquidityInCTokens = convertFromUnderlying(want.balanceOf(address(crToken)));
                //take all we can
                safeBox.withdraw(liquidityInCTokens);
            }
        }
        uint256 newBalance = want.balanceOf(address(this));

        return newBalance - balanceBefore;
    }

    function _liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _liquidatedAmount, uint256 _loss)
    {
        _loss; //should not be able to lose here

        uint256 looseAssets = want.balanceOf(address(this));

        if (looseAssets < _amountNeeded) {
            _withdrawSome(_amountNeeded - looseAssets);
        }

        _liquidatedAmount = Math.min(_amountNeeded, want.balanceOf(address(this)));
    }

    function harvestTrigger(uint256 callCost) public view override returns (bool) {
        uint256 wantCallCost = ethToWant(callCost);

        return super.harvestTrigger(wantCallCost);
    }

    function ethToWant(uint256 _amount) internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = avax;
        path[1] = address(want);

        uint256[] memory amounts = IUni(router).getAmountsOut(_amount, path);

        return amounts[amounts.length - 1];
    }

    function _prepareMigration(address _newStrategy) internal override {
        safeBox.transfer(_newStrategy, safeBox.balanceOf(address(this)));
    }

    // Override this to add all tokens/tokenized positions this contract manages
    // on a *persistent* basis (e.g. not just for swapping back to want ephemerally)
    // NOTE: Do *not* include `want`, already included in `sweep` below
    //
    // Example:
    //
    //    function protectedTokens() internal override view returns (address[] memory) {
    //      address[] memory protected = new address[](3);
    //      protected[0] = tokenA;
    //      protected[1] = tokenB;
    //      protected[2] = tokenC;
    //      return protected;
    //    }
    function _protectedTokens() internal view override returns (address[] memory) {
        address[] memory protected = new address[](1);
        protected[0] = address(safeBox);

        return protected;
    }

    function tendTrigger(uint256 _callCost) public view override returns (bool) {
        return false;
    }
}
