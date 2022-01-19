// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "../BaseStrategy.sol";
import "../interfaces/ICurve.sol";
import "../interfaces/UniSwap/IUni.sol";

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
}

contract StableConvexXPool is BaseStrategy {
    address public constant BOOSTER = address(0xF403C135812408BFbE8713b5A23a04b3D48AAE31);

    address public constant CVX = address(0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B);
    address public constant CRV = address(0xD533a949740bb3306d119CC777fa900bA034cd52);
    address public constant WETH = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public constant DAI = address(0x0);
    address public constant USDC = address(0x0);
    address public constant USDT = address(0x0);

    address public constant CRV_3POOL = address(0x0);
    IERC20 public constant CRV_3POOL_TOKEN = IERC20(address(0x0));

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
    address[] public dex;

    constructor(address _vault, int128 wantIndex) BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;

        require(
            (address(want) == DAI && wantIndex == 0) ||
                (address(want) == USDC && wantIndex == 1) ||
                (address(want) == USDT && wantIndex == 2),
            "want and wantIndex does not match"
        );
        WANT_INDEX = wantIndex;

        want.approve(CRV_3POOL, type(uint256).max);
    }

    function setMetaPool(uint256 newId, address newCurve) external onlyOwner {
        require(newId != pId, "setMetaPool: same id");
        (address lp, , , address reward, , bool shutdown) = Booster(BOOSTER).poolInfo(newId);
        require(!shutdown, "setMetaPool: pool is shutdown");
        lpToken = IERC20(lp);
        rewardContract = reward;
        pId = newId;
        curve = newCurve;

        CRV_3POOL_TOKEN.approve(curve, 0);
        CRV_3POOL_TOKEN.approve(curve, type(uint256).max);
        lpToken.approve(BOOSTER, 0);
        lpToken.approve(BOOSTER, type(uint256).max);
    }

    function switchDex(uint256 id, address newDex) external onlyAuthorized {
        dex[id] = newDex;

        IERC20 token;
        if (id == 0) {
            token = IERC20(CRV);
        } else {
            token = IERC20(CVX);
        }
        token.approve(newDex, 0);
        token.approve(newDex, type(uint256).max);
    }

    function name() external pure override returns (string memory) {
        return "StrategyConvexXPool";
    }

    function estimatedTotalAssets() public view override returns (uint256 estimated) {
        uint256 lpAmount = Rewards(rewardContract).balanceOf(address(this));
        uint256 crv3Amount = ICurveMetaPool(curve).calc_withdraw_one_coin(lpAmount, CRV3_INDEX);
        estimated = ICurve3Pool(CRV_3POOL).calc_withdraw_one_coin(crv3Amount, WANT_INDEX);
        estimated += want.balanceOf(address(this));
        estimated += _claimableBasic(TO_WANT);
    }

    function _claimableBasic(uint256 toIndex) private view returns (uint256) {
        uint256 crv = Rewards(rewardContract).earned(address(this));

        // calculations pulled directly from CVX's contract for minting CVX per CRV claimed
        uint256 totalCliffs = 1000;
        uint256 maxSupply = 1e8 * 1e18; // 100m
        uint256 reductionPerCliff = 1e5 * 1e18; // 100k
        uint256 supply = IERC20(CVX).totalSupply();
        uint256 cvx;

        uint256 cliff = supply / reductionPerCliff;
        // mint if below total cliffs
        if (cliff < totalCliffs) {
            // for reduction% take inverse of current cliff
            uint256 reduction = totalCliffs - cliff;
            // reduce
            cvx = (cvx * reduction) / totalCliffs;

            // supply cap check
            uint256 amtTillMax = maxSupply - supply;
            if (cvx > amtTillMax) {
                cvx = amtTillMax;
            }
        }

        uint256 crvValue;
        if (crv > 0) {
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

        Rewards(rewardContract).withdrawAndUnwrap(_amount, false);

        // remove liquidity from metapool

        // remove liquidity from 3pool

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
    {}

    function tendTrigger(uint256 callCost) public pure override returns (bool) {
        callCost;
        return false;
    }

    function prepareMigration(address _newStrategy) internal override {}

    function protectedTokens() internal view override returns (address[] memory) {}
}
