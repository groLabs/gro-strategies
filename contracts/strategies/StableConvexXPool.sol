// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "../BaseStrategy.sol";
import "../interfaces/IERC20Detailed.sol";
import "../interfaces/ICurve.sol";
import "../interfaces/UniSwap/IUni.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "hardhat/console.sol";

interface Booster {
    struct PoolInfo {
        address lptoken;
        address token;
        address gauge;
        address crvRewards;
        address stash;
        bool shutdown;
    }

    function poolInfo(uint256)
        external
        view
        returns (
            address,
            address,
            address,
            address,
            address,
            bool
        );

    // deposit lp tokens and stake
    function deposit(
        uint256 _pid,
        uint256 _amount,
        bool _stake
    ) external returns (bool);
}

interface Rewards {
    function balanceOf(address account) external view returns (uint256);

    function earned(address account) external view returns (uint256);

    function withdrawAndUnwrap(uint256 amount, bool claim) external returns (bool);

    function withdrawAllAndUnwrap(bool claim) external;

    function getReward() external returns (bool);
}

contract StableConvexXPool is BaseStrategy {
    using SafeERC20 for IERC20;

    address public constant BOOSTER = address(0xF403C135812408BFbE8713b5A23a04b3D48AAE31);

    address public constant CVX = address(0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B);
    address public constant CRV = address(0xD533a949740bb3306d119CC777fa900bA034cd52);
    address public constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public constant DAI = address(0x6B175474E89094C44Da98b954EedeAC495271d0F);
    address public constant USDC = address(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    address public constant USDT = address(0xdAC17F958D2ee523a2206206994597C13D831ec7);

    address public constant CRV_3POOL = address(0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7);
    IERC20 public constant CRV_3POOL_TOKEN = IERC20(address(0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490));

    address public constant UNISWAP = address(0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D);
    address public constant SUSHISWAP = address(0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F);

    int128 public constant CRV3_INDEX = 1;
    uint256 public constant CRV_METAPOOL_LEN = 2;
    uint256 public constant CRV_3POOL_LEN = 3;

    uint256 public constant TO_ETH = 0;
    uint256 public constant TO_WANT = 1;

    int128 public immutable WANT_INDEX;

    address public curve;
    IERC20 public lpToken;
    uint256 public pId;
    address public rewardContract;

    uint256 public newPId;
    address public newCurve;
    IERC20 public newLPToken;
    address public newRewardContract;

    address[] public dex;

    event LogSetNewPool(uint256 indexed newPId, address newLPToken, address newRewardContract, address newCurve);
    event LogSwitchDex(uint256 indexed id, address newDex);
    event LogChangePool(uint256 indexed newPId, address newLPToken, address newRewardContract, address newCurve);

    constructor(address _vault, int128 wantIndex) BaseStrategy(_vault) {
        profitFactor = 1000;
        uint8 decimals = IERC20Detailed(address(want)).decimals();
        debtThreshold = 1_00_000 * (uint256(10)**decimals);
        dex = new address[](2);
        _switchDex(0, UNISWAP);
        _switchDex(1, SUSHISWAP);

        require(
            (address(want) == DAI && wantIndex == 0) ||
                (address(want) == USDC && wantIndex == 1) ||
                (address(want) == USDT && wantIndex == 2),
            "want and wantIndex does not match"
        );
        WANT_INDEX = wantIndex;

        want.approve(CRV_3POOL, type(uint256).max);
    }

    function setNewPool(uint256 _newPId, address _newCurve) external onlyAuthorized {
        require(_newPId != pId, "setMetaPool: same id");
        (address lp, , , address reward, , bool shutdown) = Booster(BOOSTER).poolInfo(_newPId);
        require(!shutdown, "setMetaPool: pool is shutdown");
        IERC20 _newLPToken = IERC20(lp);
        newLPToken = _newLPToken;
        newRewardContract = reward;
        newPId = _newPId;
        newCurve = _newCurve;
        if (CRV_3POOL_TOKEN.allowance(address(this), newCurve) == 0) {
            CRV_3POOL_TOKEN.approve(newCurve, type(uint256).max);
        }
        if (_newLPToken.allowance(address(this), BOOSTER) == 0) {
            _newLPToken.approve(BOOSTER, type(uint256).max);
        }

        emit LogSetNewPool(_newPId, lp, reward, _newCurve);
    }

    function switchDex(uint256 id, address newDex) external onlyAuthorized {
        _switchDex(id, newDex);
    }

    function _switchDex(uint256 id, address newDex) private {
        dex[id] = newDex;

        IERC20 token;
        if (id == 0) {
            token = IERC20(CRV);
        } else {
            token = IERC20(CVX);
        }

        if (token.allowance(address(this), newDex) == 0) {
            token.approve(newDex, type(uint256).max);
        }
        emit LogSwitchDex(id, newDex);
    }

    function name() external pure override returns (string memory) {
        return "StrategyConvexXPool";
    }

    function estimatedTotalAssets() public view override returns (uint256 estimated) {
        estimated = _estimatedTotalAssets(true);
    }

    function _estimatedTotalAssets(bool includeReward) private view returns (uint256 estimated) {
        uint256 lpAmount = Rewards(rewardContract).balanceOf(address(this));
        uint256 crv3Amount = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, CRV3_INDEX);
        estimated = ICurve3Pool(CRV_3POOL).calc_withdraw_one_coin(crv3Amount, WANT_INDEX);
        estimated += want.balanceOf(address(this));
        if (includeReward) {
            estimated += _claimableBasic(TO_WANT);
        }
    }

    uint256 constant totalCliffs = 100;
    uint256 constant maxSupply = 1e8 * 1e18;
    uint256 constant reductionPerCliff = 1e5 * 1e18;

    function _claimableBasic(uint256 toIndex) private view returns (uint256) {
        uint256 crv = Rewards(rewardContract).earned(address(this));

        // calculations pulled directly from CVX's contract for minting CVX per CRV claimed
        uint256 supply = IERC20(CVX).totalSupply();
        uint256 cvx;

        uint256 cliff = supply / reductionPerCliff;
        // mint if below total cliffs
        if (cliff < totalCliffs) {
            // for reduction% take inverse of current cliff
            uint256 reduction = totalCliffs - cliff;
            // reduce
            cvx = (crv * reduction) / totalCliffs;

            // supply cap check
            uint256 amtTillMax = maxSupply - supply;
            if (cvx > amtTillMax) {
                cvx = amtTillMax;
            }
        }

        uint256 crvValue;
        if (crv > 0) {
            console.log("crv: %s, dex[0]: %s, toIndex: %s", crv, dex[0], toIndex);
            address[] memory path = _getPath(CRV, toIndex);
            console.log("path[0]: %s, path[1]: %s, path[2]: %s", path[0], path[1], path[2]);

            uint256[] memory crvSwap = IUni(dex[0]).getAmountsOut(crv, _getPath(CRV, toIndex));
            crvValue = crvSwap[crvSwap.length - 1];
        }

        uint256 cvxValue;
        if (cvx > 0) {
            uint256[] memory cvxSwap = IUni(dex[1]).getAmountsOut(cvx, _getPath(CVX, toIndex));
            cvxValue = cvxSwap[cvxSwap.length - 1];
        }

        return crvValue + cvxValue;
    }

    function _getPath(address from, uint256 toIndex) private view returns (address[] memory path) {
        if (toIndex == TO_ETH) {
            path = new address[](2);
            path[0] = from;
            path[1] = WETH;
        }

        if (toIndex == TO_WANT) {
            path = new address[](3);
            path[0] = from;
            path[1] = WETH;
            path[2] = address(want);
        }
    }

    function adjustPosition(uint256 _debtOutstanding) internal override {
        _debtOutstanding;
        if (emergencyExit) return;
        uint256 wantBal = want.balanceOf(address(this));
        if (wantBal > 0) {
            uint256[CRV_3POOL_LEN] memory amountsCRV3;
            amountsCRV3[uint256(int256(WANT_INDEX))] = wantBal;

            uint256 minAmount = ICurve3Pool(CRV_3POOL).calc_token_amount(amountsCRV3, true);
            minAmount = minAmount - ((minAmount * (9995)) / (10000));
            ICurve3Deposit(CRV_3POOL).add_liquidity(amountsCRV3, minAmount);

            uint256 crv3Bal = CRV_3POOL_TOKEN.balanceOf(address(this));
            if (crv3Bal > 0) {
                uint256[CRV_METAPOOL_LEN] memory amountsMP;
                amountsMP[uint256(int256(CRV3_INDEX))] = crv3Bal;

                minAmount = ICurveMetaPool(curve).calc_token_amount(amountsMP, true);
                minAmount = minAmount - ((minAmount * (9995)) / (10000));
                ICurveMetaPool(curve).add_liquidity(amountsMP, minAmount);

                uint256 lpBal = lpToken.balanceOf(address(this));
                if (lpBal > 0) {
                    Booster(BOOSTER).deposit(pId, lpBal, true);
                }
            }
        }
    }

    function liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _liquidatedAmount, uint256 _loss)
    {
        uint256 _wantBal = want.balanceOf(address(this));
        if (_wantBal < _amountNeeded) {
            _liquidatedAmount = _withdrawSome(_amountNeeded - _wantBal);
            _liquidatedAmount = _liquidatedAmount + _wantBal;
            _loss = _amountNeeded - _liquidatedAmount;
        } else {
            _liquidatedAmount = _amountNeeded;
        }
    }

    function _withdrawSome(uint256 _amount) private returns (uint256) {
        uint256 lpAmount = wantToLp(_amount);
        uint256 poolBal = Rewards(rewardContract).balanceOf(address(this));

        if (poolBal < lpAmount) {
            lpAmount = poolBal;
        }

        uint256 before = want.balanceOf(address(this));

        // withdraw from convex
        Rewards(rewardContract).withdrawAndUnwrap(lpAmount, false);

        // remove liquidity from metapool
        lpAmount = lpToken.balanceOf(address(this));
        uint256 minAmount = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, CRV3_INDEX);
        minAmount = minAmount - ((minAmount * (9995)) / (10000));
        ICurveMetaPool(curve).remove_liquidity_one_coin(lpAmount, CRV3_INDEX, minAmount);

        // remove liquidity from 3pool
        lpAmount = CRV_3POOL_TOKEN.balanceOf(address(this));
        minAmount = ICurve3Pool(CRV_3POOL).calc_withdraw_one_coin(lpAmount, WANT_INDEX);
        minAmount = minAmount - ((minAmount * (9995)) / (10000));
        ICurve3Deposit(CRV_3POOL).remove_liquidity_one_coin(lpAmount, WANT_INDEX, minAmount);

        return want.balanceOf(address(this)) - before;
    }

    function wantToLp(uint256 amount) private view returns (uint256 lpAmount) {
        uint256[CRV_3POOL_LEN] memory amountsCRV3;
        amountsCRV3[uint256(int256(WANT_INDEX))] = amount;

        uint256 crv3Amount = ICurve3Pool(CRV_3POOL).calc_token_amount(amountsCRV3, false);

        uint256[CRV_METAPOOL_LEN] memory amountsMP;
        amountsMP[uint256(int256(CRV3_INDEX))] = crv3Amount;

        lpAmount = ICurveMetaPool(curve).calc_token_amount(amountsMP, false);
    }

    function prepareReturn(uint256 _debtOutstanding)
        internal
        override
        returns (
            uint256 _profit,
            uint256 _loss,
            uint256 _debtPayment
        )
    {
        uint256 total;
        uint256 wantBal;
        if (curve == address(0)) {
            // invest into strategy first time
            console.log("invest into strategy first time");
            _changePool();
        } else if (newCurve != address(0)) {
            console.log("change pool");
            _withdrawAll();
            _changePool();
            wantBal = want.balanceOf(address(this));
            total = wantBal;
        } else {
            console.log("get profits");
            Rewards(rewardContract).getReward();
            _sellBasic();
            total = _estimatedTotalAssets(false);
            wantBal = want.balanceOf(address(this));
        }
        _debtPayment = _debtOutstanding;
        uint256 debt = vault.strategies(address(this)).totalDebt;
        console.log("vault: %s", address(vault));
        console.log("total: %s, debt: %s", total, debt);
        if (total > debt) {
            _profit = total - debt;
            uint256 amountToFree = _profit + _debtPayment;
            if (amountToFree > 0 && wantBal < amountToFree) {
                _withdrawSome(amountToFree - wantBal);
                wantBal = want.balanceOf(address(this));
                if (wantBal < amountToFree) {
                    if (_profit > wantBal) {
                        _profit = wantBal;
                        _debtPayment = 0;
                    } else {
                        _debtPayment = Math.min(wantBal - _profit, _debtPayment);
                    }
                }
            }
        } else {
            _loss = debt - total;
            uint256 amountToFree = _debtPayment;
            if (amountToFree > 0 && wantBal < amountToFree) {
                _withdrawSome(amountToFree - wantBal);
                wantBal = want.balanceOf(address(this));
                if (wantBal < amountToFree) {
                    _debtPayment = wantBal;
                }
            }
        }
    }

    function _changePool() private {
        uint256 _newPId = newPId;
        address _newCurve = newCurve;
        IERC20 _newLPToken = newLPToken;
        address _newReward = newRewardContract;

        pId = _newPId;
        curve = _newCurve;
        lpToken = _newLPToken;
        rewardContract = _newReward;

        newCurve = address(0);
        newPId = 0;
        newLPToken = IERC20(address(0));
        newRewardContract = address(0);

        emit LogChangePool(_newPId, address(_newLPToken), _newReward, _newCurve);
    }

    function _sellBasic() private {
        uint256 crv = IERC20(CRV).balanceOf(address(this));
        if (crv > 0) {
            IUni(dex[0]).swapExactTokensForTokens(
                crv,
                uint256(0),
                _getPath(CRV, TO_WANT),
                address(this),
                block.timestamp
            );
        }
        uint256 cvx = IERC20(CVX).balanceOf(address(this));
        if (cvx > 0) {
            IUni(dex[1]).swapExactTokensForTokens(
                cvx,
                uint256(0),
                _getPath(CVX, TO_WANT),
                address(this),
                block.timestamp
            );
        }
    }

    function tendTrigger(uint256 callCost) public pure override returns (bool) {
        callCost;
        return false;
    }

    function prepareMigration(address _newStrategy) internal override {
        _newStrategy;
        _withdrawAll();
    }

    function _withdrawAll() private {
        Rewards(rewardContract).withdrawAllAndUnwrap(true);
        _sellBasic();

        // remove liquidity from metapool
        uint256 lpAmount = lpToken.balanceOf(address(this));
        uint256 minAmount = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, CRV3_INDEX);
        minAmount = minAmount - ((minAmount * (9995)) / (10000));
        ICurveMetaPool(curve).remove_liquidity_one_coin(lpAmount, CRV3_INDEX, minAmount);

        // remove liquidity from 3pool
        lpAmount = CRV_3POOL_TOKEN.balanceOf(address(this));
        minAmount = ICurve3Pool(CRV_3POOL).calc_withdraw_one_coin(lpAmount, WANT_INDEX);
        minAmount = minAmount - ((minAmount * (9995)) / (10000));
        ICurve3Deposit(CRV_3POOL).remove_liquidity_one_coin(lpAmount, WANT_INDEX, minAmount);
    }

    function protectedTokens() internal pure override returns (address[] memory) {
        address[] memory protected = new address[](2);
        protected[0] = CRV;
        protected[1] = CVX;
        return protected;
    }

    function harvestTrigger(uint256 callCost) public view override returns (bool) {
        StrategyParams memory params = vault.strategies(address(this));

        if (params.activation == 0) return false;

        if (block.timestamp - params.lastReport < minReportDelay) return false;

        if (block.timestamp - params.lastReport >= maxReportDelay) return true;

        uint256 outstanding = vault.debtOutstanding();
        if (outstanding > debtThreshold) return true;

        uint256 total = estimatedTotalAssets();
        if (total + debtThreshold < params.totalDebt) return true;

        uint256 profit;
        if (total > params.totalDebt) {
            profit = total - params.totalDebt;
        }

        return (profitFactor * callCost < _wantToETH(profit));
    }

    function _wantToETH(uint256 wantAmount) private view returns (uint256) {
        if (wantAmount > 0) {
            address[] memory path = new address[](2);
            path[0] = address(want);
            path[1] = WETH;
            uint256[] memory amounts = IUni(dex[0]).getAmountsOut(wantAmount, path);
            return amounts[1];
        }
    }
}
