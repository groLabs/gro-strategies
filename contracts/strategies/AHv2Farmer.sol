// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../BaseStrategy.sol";

/*//////////////////////////
 *          INTERFACES
 *//////////////////////////

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

// Uniswap pool interface
interface IUniPool {
    function getReserves()
        external
        view
        returns (
            uint112 _reserve0,
            uint112 _reserve1,
            uint32 _blockTimestampLast
        );

    function totalSupply() external view returns (uint256);
}

interface IHomoraOracle {
    function getETHPx(address token) external view returns (uint256);
}

// HomoraBank interface
interface IHomora {
    function execute(
        uint256 _positionId,
        address _spell,
        bytes memory _data
    ) external payable returns (uint256);

    function getPositionInfo(uint256 _positionId)
        external
        view
        returns (
            address owner,
            address collToken,
            uint256 collId,
            uint256 collateralSize
        );

    function getPositionDebts(uint256 _positionId)
        external
        view
        returns (address[] memory tokens, uint256[] memory debts);
}

// AH master chef tracker interface
interface IWMasterChef {
    function balanceOf(address _account, uint256 _id)
        external
        view
        returns (uint256);

    function decodeId(uint256 _id)
        external
        pure
        returns (uint256 pid, uint256 sushiPerShare);
}

// Master chef interface
interface IMasterChef {
    function poolInfo(uint256 _pid)
        external
        view
        returns (
            address lpToken,
            uint256 allocPoint,
            uint256 lastRewardBlock,
            uint256 accSushiPerShare
        );
}

/* @notice AHv2Farmer - Alpha Homora V2 yield aggregator strategy
 *
 *      Farming AHv2 Stable/AVAX positions.
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
 *      to AH, and borrow avax in a proportional amount. Under certian circumstances the strategy will stop
 *      it's borrowing, but will not ever attempt to borrow want from AH.
 *
 *  ###############################################
 *      Strategy specifications
 *  ###############################################
 *
 *  The strategy sets out to fulfill the following requirements:
 *  - Open new positions
 *  - Close active positions
 *  - Adjust active positions
 *  - Interact with Gro vault adapters (GVA):
 *      - Report gains/losses
 *      - Borrow assets from GVA to invest into AHv2
 *      - Repay debts to GVA
 *      - Accommodate withdrawals from GVA
 *
 * The strategy keeps track of the following:
 *   - Price changes in opening position
 *   - Collateral ratio of AHv2 position
 *
 * If any of these go out of a preset threshold, the strategy will attempt to close down the position.
 *  If the collateral factor move away from the ideal target, the strategy won't take on more debt from alpha
 *  homora when adding assets to the position.
 */
contract AHv2Farmer is BaseStrategy {
    using SafeERC20 for IERC20;

    // Base constants
    uint256 public constant PERCENTAGE_DECIMAL_FACTOR = 1E4;
    // LP Pool token
    IUniPool public immutable pool;
    uint256 immutable decimals;
    address public constant wavax =
        address(0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7);
    IHomoraOracle public constant homoraOralce =
        IHomoraOracle(0xc842CC25FE89F0A60Fe9C1fd6483B6971020Eb3A);
    // Full repay
    uint256 constant REPAY = type(uint256).max;

    // UniV2 or Sushi swap style router
    IUni public immutable uniSwapRouter;
    // comment out if uniSwap spell is used
    address public constant yieldToken =
        address(0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd);
    address public constant homoraBank =
        address(0x376d16C7dE138B01455a51dA79AD65806E9cd694);
    address public constant masterChef =
        address(0xd6a4F121CA35509aF06A0Be99093d08462f53052);
    IWMasterChef public constant wMasterChef =
        IWMasterChef(0xB41DE9c1f50697cC3Fd63F24EdE2B40f6269CBcb);
    address public immutable spell;

    // strategies current position
    uint256 public activePosition;
    // How much change we accept in AVAX price before closing or adjusting the position
    uint256 public ilThreshold = 400; // 4%

    // In case no direct path exists for the swap, use this token as an inermidiary step
    address public immutable indirectPath;
    // liq. pool token order, used to determine if calculations should be reversed or not
    // first token in liquidity pool
    address public immutable tokenA;
    // second token in liquidity pool
    address public immutable tokenB;

    // poolId for masterchef - can be commented out for non sushi spells
    uint256 public immutable poolId;

    // Min amount of tokens to open/adjust positions or sell
    uint256 public minWant;
    // Amount of tokens to sell as a % of pool liq. depth
    uint256 public sellThreshold = 10; // 0.1%
    // Thresholds for the different tokens sold
    mapping(address => uint256) public ammThreshold;
    // How short on avax a position is allowed to be before adjusting
    uint256 public exposureThreshold = 50; // 0.5 %
    // Amount of short/long position to liquidate from position
    uint256 public adjustRatio = 5000; // 50 %
    // Limits the size of a position based on how much is available to borrow
    uint256 public borrowLimit;
    // strategy positions
    mapping(uint256 => PositionData) positions;

    // function headers for generating signatures for encoding function calls
    // AHv2 homorabank uses encoded spell function calls in order to cast spells
    string constant spellOpen =
        "addLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)";
    string constant spellClose =
        "removeLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256))";

    /*//////////////////////////
     *          EVENTS
     *//////////////////////////

    event LogNewPositionOpened(
        uint256 indexed positionId,
        uint256[] price,
        uint256 collateralSize
    );

    event LogPositionClosed(
        uint256 indexed positionId,
        uint256 wantRecieved,
        uint256[] price
    );

    event LogPositionAdjusted(
        uint256 indexed positionId,
        uint256[] amounts,
        uint256 collateralSize,
        bool withdrawal
    );

    event LogAVAXSold(uint256[] AVAXSold);
    event LogYieldTokenSold(uint256[] yieldTokenSold);

    event NewFarmer(
        address vault,
        address spell,
        address router,
        address pool,
        uint256 poolId
    );
    event LogNewReserversSet(uint256 reserve);
    event LogNewMinWantSet(uint256 minWawnt);
    event LogNewBorrowLimit(uint256 newLimit);
    event LogNewStrategyThresholds(uint256 ilThreshold, uint256 sellThreshold, uint256 exposureThreshold, uint256 adjustRatio);
    event LogNewAmmThreshold(address token, uint256 newThreshold);

    struct PositionData {
        uint256[] wantClose; // AVAX value of position when closed [want => AVAX]
        uint256 totalClose; // total value of position on close
        uint256[] wantOpen; // AVAX value of position when opened [want => AVAX]
        uint256 collId; // collateral ID
        uint256 collateral; // collateral amount
        uint256[] timestamps; // open/close position stamps
    }

    struct Amounts {
        uint256 aUser; // Supplied tokenA amount
        uint256 bUser; // Supplied tokenB amount
        uint256 lpUser; // Supplied LP token amount
        uint256 aBorrow; // Borrow tokenA amount
        uint256 bBorrow; // Borrow tokenB amount
        uint256 lpBorrow; // Borrow LP token amount
        uint256 aMin; // Desired tokenA amount (slippage control)
        uint256 bMin; // Desired tokenB amount (slippage control)
    }

    struct RepayAmounts {
        uint256 lpTake; // Take out LP token amount (from Homora)
        uint256 lpWithdraw; // Withdraw LP token amount (back to caller)
        uint256 aRepay; // Repay tokenA amount
        uint256 bRepay; // Repay tokenB amount
        uint256 lpRepay; // Repay LP token amount
        uint256 aMin; // Desired tokenA amount
        uint256 bMin; // Desired tokenB amount
    }

    constructor(
        address _vault,
        address _spell,
        address _router,
        address _pool,
        uint256 _poolId,
        address[] memory _tokens,
        address _indirectPath
    ) BaseStrategy(_vault) {
        uint256 _decimals = IVault(_vault).decimals();
        decimals = _decimals;
        tokenA = _tokens[0];
        tokenB = _tokens[1];
        indirectPath = _indirectPath;
        debtThreshold = 1_000_000 * (10**_decimals);
        // approve the homora bank to use our want
        want.safeApprove(homoraBank, type(uint256).max);
        // approve the router to use our yieldToken
        IERC20(yieldToken).safeApprove(_router, type(uint256).max);
        spell = _spell;
        uniSwapRouter = IUni(_router);
        pool = IUniPool(_pool);
        poolId = _poolId;
        emit NewFarmer(_vault, _spell, _router, _pool, _poolId);
    }

    // Strategy will recieve AVAX from closing/adjusting positions, do nothing with the AVAX here
    receive() external payable {}

    /*//////////////////////////
     *    Getters
     *//////////////////////////

    // Strategy name
    function name() external pure override returns (string memory) {
        return "AHv2 strategy";
    }

    // Default getter for public structs dont return dynamics arrays, so we add this here
    function getPosition(uint256 _positionId)
        external
        view
        returns (PositionData memory)
    {
        return positions[_positionId];
    }

    // Function for testing purposes
    /////////////////////////////////
    // function getExposure() external view returns (bool, bool, uint256[] memory, int256, uint256[] memory) {
    //     uint256 positionId = activePosition;
    //     bool check;
    //     bool short;
    //     uint256[] memory lp;
    //     if (positionId > 0) {
    //         (check, short, lp) = _calcAVAXExposure(positionId, positions[positionId].collateral);
    //     }
    //     (uint256[] memory lpPosition, int256 AVAXPosition) = _calcAVAXPosition(positionId, positions[positionId].collateral);
    //     return (check, short, lp, AVAXPosition, lpPosition);
    // }

    /*//////////////////////////
     *    Setters
     *//////////////////////////

    /*
     * @notice set minimum want required to adjust position
     * @param _minWant minimum amount of want
     */
    function setMinWant(uint256 _minWant) external onlyOwner {
        minWant = _minWant;
        emit LogNewMinWantSet(_minWant);
    }

    /*
     * @notice set threshold for amm check
     * @param _threshold new threshold
     */
    function setAmmThreshold(address _token, uint256 _threshold)
        external
        onlyOwner
    {
        ammThreshold[_token] = _threshold;
        emit LogNewAmmThreshold(_token, _threshold);
    }

    /*
     * @notice set minimum want required to adjust position
     * @param _minWant minimum amount of want
     */
    function setBorrowLimit(uint256 _newLimt) external onlyAuthorized {
        borrowLimit = _newLimt;
        emit LogNewBorrowLimit(_newLimt);
    }

    /*
     * @notice setters for varius strategy variables
     * @param _ilThreshold new il threshold
     * @param _sellThreshold threshold of pool depth in BP
     * @param _exposureThreshold amount the positiong can go long/short before adjusting
     * @param _adjustRatio amount of long/short position to liquidate
     * @dev combined multiple setters to save space in strategy
     */
    function setStrategyThresholds(
        uint256 _ilThreshold,
        uint256 _sellThreshold,
        uint256 _exposureThreshold,
        uint256 _adjustRatio
    ) external onlyOwner {
        ilThreshold = _ilThreshold;
        sellThreshold = _sellThreshold;
        exposureThreshold = _exposureThreshold;
        adjustRatio = _adjustRatio;
        emit LogNewStrategyThresholds(_ilThreshold, _sellThreshold, _exposureThreshold, _adjustRatio);
    }

    /*
     * @notice Estimate amount of yield tokens that will be claimed if position is closed
     * @param _positionId ID of a AHv2 position
     */
    function pendingYieldToken(uint256 _positionId)
        public
        view
        returns (uint256)
    {
        if (_positionId == 0) return 0;
        // get balance of collateral
        uint256 amount = positions[_positionId].collateral;
        (uint256 pid, uint256 stYieldTokenPerShare) = wMasterChef.decodeId(
            positions[_positionId].collId
        );
        (, , , uint256 enYieldTokenPerShare) = IMasterChef(masterChef).poolInfo(
            pid
        );
        uint256 stYieldToken = (stYieldTokenPerShare * amount - 1) / 1e12;
        uint256 enYieldToken = (enYieldTokenPerShare * amount) / 1e12;
        if (enYieldToken > stYieldToken) {
            return enYieldToken - stYieldToken;
        }
        return 0;
    }

    /*//////////////////////////
     *    Core logic
     *//////////////////////////

    /*
     * @notice Calculate strategies current loss, profit and amount if can repay
     * @param _debtOutstanding amount of debt remaining to be repaid
     */
    function _prepareReturn(uint256 _debtOutstanding)
        internal
        returns (
            uint256 profit,
            uint256 loss,
            uint256 debtPayment,
            uint256 positionId
        )
    {
        uint256 balance;
        // only try to realize profits if there is no active position
        _sellAVAX();
        _sellYieldToken();
        positionId = activePosition;
        if (positionId == 0 || _debtOutstanding > 0) {
            balance = want.balanceOf(address(this));
            if (balance < _debtOutstanding && positionId > 0) {
                // withdraw to cover the debt
                if (compare(_debtOutstanding, (positions[positionId].wantOpen[0] + balance), 8000)) {
                    balance = 0;
                } else {
                    balance = _debtOutstanding - balance;
                }
                positionId = _closePosition(positionId, balance, true, true);
                balance = want.balanceOf(address(this));
            }
            debtPayment = Math.min(balance, _debtOutstanding);

            if (positionId == 0) {
                uint256 debt = vault.strategies(address(this)).totalDebt;
                // Balance - Total Debt is profit
                if (balance > debt) {
                    profit = balance - debt;
                    if (balance < profit) {     
                        profit = balance;
                    } else if (balance > profit + _debtOutstanding){
                        debtPayment = _debtOutstanding;
                    } else {
                        debtPayment = balance - profit;
                    }
                } else {
                    loss = debt - balance;
                }

            }
        }
    }

    /*
     * @notice partially removes or closes the current AH v2 position in order to repay a requested amount
     * @param _amountNeeded amount needed to be withdrawn from strategy
     * @dev This function will atempt to remove part of the current position in order to repay debt or accomodate a withdrawal,
     *      This is a gas costly operation, should not be atempted unless the amount being withdrawn warrants it.
     */
    function _liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 amountFreed, uint256 loss)
    {
        require(_ammCheck(decimals, address(want)), "!ammCheck");
        // want in contract + want value of position based of AVAX value of position (total - borrowed)
        uint256 _positionId = activePosition;

        (uint256 assets, uint256 _balance) = _estimatedTotalAssets(_positionId);

        uint256 debt = vault.strategyDebt();

        // cannot repay the entire debt
        if (debt > assets) {
            loss = debt - assets;
            if (loss >= _amountNeeded) {
                loss = _amountNeeded;
                amountFreed = 0;
                return (amountFreed, loss);
            }
            _amountNeeded = _amountNeeded - loss;
        }

        // do we have enough assets in strategy to repay?
        if (_balance < _amountNeeded) {
            if (activePosition > 0) {
                uint256 remainder;
                // because pulling out assets from AHv2 tends to give us less assets than
                // we want specify, so lets see if we can pull out a bit in excess to be
                // able to pay back the full amount
                if (assets > _amountNeeded + 100 * (10**decimals)) {
                    remainder = _amountNeeded - _balance + 100 * (10**decimals);
                } else {
                    // but if not possible just pull the original amount
                    remainder = _amountNeeded - _balance;
                }

                // if we want to remove 80% or more of the position, just close it
                if (compare(remainder, assets, 8000)) {
                    _closePosition(_positionId, 0, true, true);
                    _sellAVAX();
                    _sellYieldToken();
                } else {
                    _closePosition(_positionId, remainder, true, true);
                }
            }

            // dont return more than was asked for
            amountFreed = Math.min(
                _amountNeeded,
                want.balanceOf(address(this))
            );
            loss += _amountNeeded - amountFreed;
        } else {
            amountFreed = _amountNeeded;
        }
        return (amountFreed, loss);
    }

    /*
     * @notice adjust current position, repaying any debt
     * @param _debtOutstanding amount of outstanding debt the strategy holds
     * @dev _debtOutstanding should always be 0 here, but we should handle the
     *      eventuality that something goes wrong in the reporting, in which case
     *      this strategy should act conservative and atempt to repay any outstanding amount
     */
    function _adjustPosition(
        uint256 _positionId, 
        bool _check,
        uint256 _remainingLimit
    ) internal {
        //emergency exit is dealt with in liquidatePosition
        if (emergencyExit) {
            return;
        }

        if (_check) {
            _closePosition(_positionId, 0, false, true);
            return;
        }
        //we are spending all our cash unless we have debt outstanding
        uint256 wantBal = want.balanceOf(address(this));

        // check if the current want amount is large enough to justify opening/adding
        // to an existing position, else do nothing
        if (wantBal > _remainingLimit) wantBal = _remainingLimit;
        if (wantBal >= minWant && address(this).balance < 1E18) {
            if (_positionId == 0) {
                _openPosition(true, 0, wantBal);
            } else {
                // TODO logic to lower the collateral ratio
                // When adding to the position we will try to stabilize the collateralization ratio, this
                //  will be possible if we owe more than originally, as we just need to borrow less AVAX
                //  from AHv2. The opposit will currently not work as we want to avoid taking on want
                //  debt from AHv2.

                // else if (changeFactor > 0) {
                //     // See what the % of the position the current pos is
                //     uint256 assets = _calcEstimatedWant(_positionId);
                //     uint256[] memory oldPrice = positions[_positionId].openWant;
                //     uint256 newPercentage = (newPosition[0] * PERCENTAGE_DECIMAL_FACTOR / oldPrice[0])
                // }
                _openPosition(false, _positionId, wantBal);
            }
        } else if (_positionId > 0) {
            uint256[] memory lpPosition;
            uint256 collateral = positions[_positionId].collateral;
            bool short;
            (_check, short, lpPosition) = _calcAVAXExposure(_positionId, collateral);
            if (_check) {
                _closePosition(_positionId, lpPosition[1], !short, short);
            }
        }
    }

    /*//////////////////////////
     *    Alpha Homora functions
     *//////////////////////////

    /*
     * @notice Open a new AHv2 position with market neutral leverage
     * @param _new is it a new position
     * @param _positionId id of position if adding
     * @param amount amount of want to provide to prosition
     */
    function _openPosition(
        bool _new,
        uint256 _positionId,
        uint256 _amount
    ) internal {
        (uint256[] memory amounts, ) = _calcSingleSidedLiq(_amount, false);
        Amounts memory amt = _formatOpen(amounts);
        _positionId = IHomora(homoraBank).execute(
            _positionId,
            spell,
            abi.encodeWithSignature(spellOpen, tokenA, tokenB, amt, poolId)
        );
        _setPositionData(_positionId, amounts, _new, false);
    }

    /*
     * @notice Close and active AHv2 position
     * @param _positionId ID of position to close
     * @param _amount amount of want to remove
     * @param _force Force close position, set minAmount to 0/0
     */
    function _closePosition(
        uint256 _positionId,
        uint256 _amount,
        bool _withdraw,
        bool _repay
    ) internal returns (uint256) {
        // active position data
        uint256[] memory minAmounts;
        uint256[] memory amounts;
        uint256 collateral;
        uint256 wantBal;
        bool _partial;
        if (_amount > 0) {
            _partial = true;
            (amounts, collateral) = _calcSingleSidedLiq(_amount, true);
            minAmounts = new uint256[](2);
            if (_withdraw) {
                minAmounts[1] =
                    (amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 100)) /
                    PERCENTAGE_DECIMAL_FACTOR;
            } else {
                amounts[1] =
                    (amounts[1] * (PERCENTAGE_DECIMAL_FACTOR - 100)) /
                    PERCENTAGE_DECIMAL_FACTOR;
                collateral = collateral / 2;
            }
        } else {
            PositionData storage pd = positions[_positionId];
            collateral = pd.collateral;
            wantBal = want.balanceOf(address(this));
            amounts = new uint256[](2);
            amounts[1] = REPAY;
            // Calculate amount we expect to get out by closing the position (applying 0.5% slippage)
            // Note, expected will be [AVAX, want], as debts always will be [AVAX] and solidity doesnt support
            // sensible operations like [::-1] or zip...
            (minAmounts, ) = _calcAvailable(
                _positionId,
                (collateral * (PERCENTAGE_DECIMAL_FACTOR - 50)) /
                    PERCENTAGE_DECIMAL_FACTOR
            );
        }
        if (!_repay) amounts[1] = 0;
        _positionId = _homoraClose(_positionId, minAmounts, collateral, amounts[1]);
        if (_partial) {
            _setPositionData(_positionId, amounts, false, true);
            return _positionId;
        } else {
            // Do not sell after closing down the position, AVAX/yieldToken are sold during
            //  the early stages for the harvest flow (see prepareReturn)
            // total amount of want retrieved from position
            wantBal = want.balanceOf(address(this)) - wantBal;
            _closePositionData(_positionId, wantBal);
            return 0;
        }
    }

    /*
     * @notice Format data and close/remove assets from position
     * @param _positionId id of position
     * @param _minAmounts minimum amounts that we expect to get back
     * @param _collateral amount of collateral to burn
     * @param _repay amount to repay
     */
    function _homoraClose(
        uint256 _positionId,
        uint256[] memory _minAmounts,
        uint256 _collateral,
        uint256 _repay
    ) private returns (uint256)
    {
        RepayAmounts memory amt = _formatClose(_minAmounts, _collateral, _repay);
        return IHomora(homoraBank).execute(
            _positionId,
            spell,
            abi.encodeWithSignature(spellClose, tokenA, tokenB, amt)
        );
    }

    ////// Format functions for Alpha Homora spells

    /*
     * @notice format the open position input struct
     * @param _amounts Amounts for position
     */
    function _formatOpen(uint256[] memory _amounts)
        internal
        view
        returns (Amounts memory amt)
    {
        // Unless we borrow we only supply a value for the want we provide
        if (tokenA == address(want)) {
            amt.aUser = _amounts[0];
            amt.bBorrow = _amounts[1];
        } else {
            amt.bUser = _amounts[0];
            amt.aBorrow = _amounts[1];
        }
    }

    /*
     * @notice format the close position input struct
     * @param _expect expected return amounts
     * @param _collateral collateral to remove from position
     * @param _repay amount to repay - default to max value if closing position
     */
    function _formatClose(
        uint256[] memory _expected,
        uint256 _collateral,
        uint256 _repay
    ) internal view returns (RepayAmounts memory amt) {
        amt.lpTake = _collateral;
        if (tokenA == address(want)) {
            amt.aMin = _expected[1];
            amt.bMin = _expected[0];
            amt.bRepay = _repay;
        } else {
            amt.aMin = _expected[0];
            amt.bMin = _expected[1];
            amt.aRepay = _repay;
        }
    }

    /*//////////////////////////
     *    Oracle logic
     *//////////////////////////

    /*
     * @notice Check if price change is outside the accepted range,
     *      in which case the the opsition needs to be closed or adjusted
     */
    function volatilityCheck() public view returns (bool) {
        if (activePosition == 0) {
            return false;
        }
        uint256[] memory openPrice = positions[activePosition].wantOpen;
        (uint256[] memory currentPrice, ) = _calcSingleSidedLiq(
            openPrice[0],
            false
        );
        bool check = (openPrice[1] < currentPrice[1]) ? 
            compare(currentPrice[1], openPrice[1], ilThreshold+PERCENTAGE_DECIMAL_FACTOR) : 
            compare(openPrice[1], currentPrice[1], ilThreshold+PERCENTAGE_DECIMAL_FACTOR);
        return check;
    }

    /*
     * @notice Compare prices in amm vs external oralce
     * @param _decimals decimal of token, used to determine spot price
     * @param _start token to check
     * @dev The following price check is done AHOracle [token/Avax] / Amm [token/Avax], this
     *      Value needs to be within the AMMthreshold for the transaction to proceed
     */
    function _ammCheck(uint256 _decimals, address _start)
        internal
        view
        returns (bool)
    {
        // Homor oracle avax price for token
        uint256 ethPx = IHomoraOracle(homoraOralce).getETHPx(_start);
        address[] memory path = new address[](2);
        path[0] = _start;
        path[1] = wavax;
        // Joe router price
        uint256[] memory amounts = uniSwapRouter.getAmountsOut(
            10**_decimals,
            path
        );
        // Normalize homora price and add the default decimal factor to get it to BP
        uint256 diff = ((ethPx * 10**(_decimals + 4)) / 2**112) / amounts[1];
        diff = (diff > PERCENTAGE_DECIMAL_FACTOR)
            ? diff - PERCENTAGE_DECIMAL_FACTOR
            : PERCENTAGE_DECIMAL_FACTOR - diff;
        // check the difference against the ammThreshold
        if (diff < ammThreshold[_start]) return true;
    }

    /*
     * @notice check if the position needs to be closed or adjusted
     * @param _positionId active position
     */
    function _checkPositionHealth(uint256 _positionId)
        internal
        view
        returns (bool, uint256)
    {
        uint256 posWant;
        if (_positionId > 0) {
            posWant = positions[_positionId].wantOpen[0];
            if (
                posWant >= borrowLimit ||
                volatilityCheck() ||
                block.timestamp - positions[_positionId].timestamps[0] >=
                maxReportDelay
            ) {
                return (true, 0);
            }
        }
        return (false, borrowLimit - posWant);
    }

    /*//////////////////////////
     *    Position tracking
     *//////////////////////////

    /*
     * @notice Create or update the position data for indicated position
     * @param _positionId ID of position
     * @param _amounts Amounts add/withdrawn from position
     * @param _newPosition Is the position a new one
     * @param _withdraw Was the action a withdrawal
     */
    function _setPositionData(
        uint256 _positionId,
        uint256[] memory _amounts,
        bool _newPosition,
        bool _withdraw
    ) internal {
        // get position data
        (, , uint256 collId, uint256 collateralSize) = IHomora(homoraBank)
            .getPositionInfo(_positionId);

        PositionData storage pos = positions[_positionId];
        if (_newPosition) {
            activePosition = _positionId;
            pos.timestamps.push(block.timestamp);
            pos.wantOpen = _amounts;
            pos.collId = collId;
            pos.collateral = collateralSize;
            emit LogNewPositionOpened(
                _positionId,
                _amounts,
                collateralSize
            );
        } else {
            // previous position price
            uint256[] memory _openPrice = pos.wantOpen;
            if (!_withdraw) {
                _openPrice[0] += _amounts[0];
                _openPrice[1] += _amounts[1];
            } else {
                _openPrice[0] -= _amounts[0];
                _openPrice[1] -= _amounts[1];
            }
            pos.wantOpen = _openPrice;
            pos.collateral = collateralSize;
            emit LogPositionAdjusted(
                _positionId,
                _amounts,
                collateralSize,
                _withdraw
            );
        }
    }

    /*
     * @notice Update position data when closing a position
     * @param _positionId id of position that was closed
     * @param _amounts total amounts that was returned by position (exclused avax and yield tokens)
     */
    function _closePositionData(uint256 _positionId, uint256 _amount) private {
        PositionData storage pos = positions[_positionId];
        pos.timestamps.push(block.timestamp);
        pos.totalClose = _amount;
        uint256[] memory _wantClose = _uniPrice(
            pos.wantOpen[0],
            address(want)
        );
        pos.wantClose = _wantClose;
        activePosition = 0;
        emit LogPositionClosed(_positionId, _amount, _wantClose);
    }

    /*//////////////////////////
     *    UniSwap functions
     *//////////////////////////

    /*
     * @notice sell the contracts AVAX for want if there enough to justify the sell
     * @param _all sell all available avax
     */
    function _sellAVAX() internal {
        uint256 balance = address(this).balance;

        // check if we have enough AVAX to sell
        if (balance == 0) {
            return;
        }

        (, uint112 resB) = _getPoolReserves();
        if (balance * PERCENTAGE_DECIMAL_FACTOR / resB > sellThreshold) {
            balance = resB * sellThreshold / PERCENTAGE_DECIMAL_FACTOR;
        }
        // Use a call to the uniswap router contract to swap exact AVAX for want
        // note, minwant could be set to 0 here as it doesnt matter, this call
        // cannot prevent any frontrunning and the transaction should be executed
        // using a private host. When lacking a private host it needs to rely on the
        // AMM check or ues the manual see function between harvest.
        uint256[] memory amounts = uniSwapRouter.swapExactAVAXForTokens{
            value: balance
        }(0, _getPath(wavax), address(this), block.timestamp);
        emit LogAVAXSold(amounts);
    }

    /*
     * @notice sell the contracts yield tokens for want if there enough to justify the sell - can remove this method if uni swap spell
     */
    function _sellYieldToken() internal {
        uint256 balance = IERC20(yieldToken).balanceOf(address(this));
        if (balance == 0) return;
        require(_ammCheck(18, yieldToken), "!ammCheck");
        uint256[] memory amounts = uniSwapRouter.swapExactTokensForTokens(
            balance,
            0,
            _getPath(yieldToken),
            address(this),
            block.timestamp
        );
        emit LogYieldTokenSold(amounts);
    }

    /*
     * @notice calculate want and AVAX value of lp position
     *      value of lp is defined by (in uniswap routerv2):
     *          lp = Math.min(input0 * poolBalance / reserve0, input1 * poolBalance / reserve1)
     *      which in turn implies:
     *          input0 = reserve0 * lp / poolBalance
     *          input1 = reserve1 * lp / poolBalance
     * @param _collateral lp amount
     * @dev Note that we swap the order of want and AVAX in the return array, this is because
     *      the debt position always will be in AVAX, and to save gas we dont add a 0 value for the
     *      want debt. So when doing repay calculations we need to remove the debt from the AVAX amount,
     *      which becomes simpler if the AVAX position comes first.
     */
    function _calcLpPosition(uint256 _collateral)
        internal
        view
        returns (uint256[] memory)
    {
        (uint112 resA, uint112 resB) = _getPoolReserves();
        uint256 poolBalance = IUniPool(pool).totalSupply();
        uint256[] memory lpPosition = new uint256[](2);

        lpPosition[1] = ((_collateral * uint256(resA)) / poolBalance);
        lpPosition[0] = ((_collateral * uint256(resB)) / poolBalance);

        return lpPosition;
    }

    /*
     * @notice get reserves from uniswap v2 style pool
     * @dev Depending on order of tokens return value may be reversed, as
     *      strategy expects Stable Coin/Avax
     */
    function _getPoolReserves()
        private
        view
        returns (uint112 resA, uint112 resB)
    {
        if (tokenA == address(want)) {
            (resA, resB, ) = pool.getReserves();
        } else {
            (resB, resA, ) = pool.getReserves();
        }
    }

    /*
     * @notice Calculate how much AVAX needs to be provided for a set amount of want
     *      when adding liquidity - This is used to estimate how much to borrow from AH.
     *      We need to solve the AH optimal swap formula for 0, which can be achieved by taking:
     *          uint _c = (amtA.mul(resB)).sub(amtB.mul(resA));
     *          uint c = _c.mul(1000).div(amtB.add(resB)).mul(resA);
     *      and rewriting it to:
     *          (A * resB - B * resA) * K / (B + resB)
     *      Which we in turn can simplify to:
     *          B = (resB * A * k  - resB) / (resA * k + 1);
     *      B (the amount of the second pool component) needs to be less than or equal to the RHS
     *      in order for the optional swap formula to not perform a swap.
     * @param _amount amount of want
     * @param _withdraw we need to calculate the liquidity amount if withdrawing
     * @dev Small enough position may revert in these calculations, this can be avoided by setting an
     *  appropriate minWant
     */
    function _calcSingleSidedLiq(uint256 _amount, bool _withdraw)
        internal
        view
        returns (uint256[] memory, uint256)
    {
        (uint112 resA, uint112 resB) = _getPoolReserves();
        uint256[] memory amt = new uint256[](2);
        amt[1] =
            (resB * 1000 * _amount - resB) /
            (resA * 1000 + 10**decimals) -
            1;
        amt[0] = _amount;
        if (_withdraw) {
            uint256 poolBalance = IUniPool(pool).totalSupply();
            uint256 liquidity = Math.min(
                (amt[0] * poolBalance) / resA,
                (amt[1] * poolBalance) / resB
            );
            return (amt, liquidity);
        }
        return (amt, 0);
    }

    /*
     * @notice get swap price in uniswap pool
     * @param _amount amount of token to swap
     * @param _start token to swap out
     */
    function _uniPrice(uint256 _amount, address _start)
        internal
        view
        returns (uint256[] memory)
    {
        if (_amount == 0) {
            return new uint256[](2);
        }
        uint256[] memory amounts = uniSwapRouter.getAmountsOut(
            _amount,
            _getPath(_start)
        );

        return amounts;
    }

    /*//////////////////////////
     *    Emergency logic
     *//////////////////////////

    /*
     * @notice Manually wind down an AHv2 position
     * @param _positionId ID of position to close
     */
    function forceClose(uint256 _positionId) external onlyAuthorized {
        PositionData storage pd = positions[_positionId];
        uint256 collateral = pd.collateral;
        uint256[] memory minAmounts = new uint256[](2);
        uint256 wantBal = want.balanceOf(address(this));
        _homoraClose(_positionId, minAmounts, collateral, REPAY);
        wantBal = want.balanceOf(address(this)) - wantBal;
        _closePositionData(_positionId, wantBal);
    }

    /*//////////////////////////
     *    Asset Views
     *//////////////////////////

    //////// External

    function estimatedTotalAssets() external view override returns (uint256) {
        (uint256 totalAssets, ) = _estimatedTotalAssets(activePosition);
        return totalAssets;
    }

    /*
     * @notice expected profit/loss of the strategy
     */
    function expectedReturn() external view returns (uint256) {
        (uint256 totalAssets, ) = _estimatedTotalAssets(activePosition);
        uint256 debt = vault.strategyDebt();
        if (totalAssets < debt) return 0;
        return totalAssets - debt;
    }

    /*
     * @notice want value of position
     */
    function calcEstimatedWant() external view returns (uint256) {
        uint256 _positionId = activePosition;
        if (_positionId == 0) return 0;
        return _calcEstimatedWant(_positionId);
    }

    ///////// Internal

    /*
     * @notice Get the estimated total assets of this strategy in want.
     *      This method is only used to pull out debt if debt ratio has changed.
     * @param _positionId active position
     * @return Total assets in want this strategy has invested into underlying protocol and
     *      the balance of this contract as a seperate variable
     */
    function _estimatedTotalAssets(uint256 _positionId)
        private
        view
        returns (uint256, uint256)
    {
        // get the value of the current position supplied by this strategy (total - borrowed)
        uint256 yieldTokenBalance = IERC20(yieldToken).balanceOf(address(this));
        uint256[] memory _valueOfAVAX = _uniPrice(address(this).balance, wavax);
        uint256 _reserve = want.balanceOf(address(this));

        if (_positionId == 0) {
            return (
                _valueOfYieldToken(_positionId, yieldTokenBalance) +
                    _valueOfAVAX[1] +
                    _reserve,
                _reserve
            );
        }
        return (
            _reserve +
                _calcEstimatedWant(_positionId) +
                _valueOfYieldToken(_positionId, yieldTokenBalance) +
                _valueOfAVAX[1],
            _reserve
        );
    }

    /*
     * @notice calculate how much expected returns we will get when closing down our position,
     *      this involves calculating the value of the collateral for the position (lp),
     *      and repaying the existing debt to Alpha homora. Two potential outcomes can come from this:
     *          - the position returns more AVAX than debt:
     *              in which case the strategy will collect the AVAX and atempt to sell it
     *          - the position returns less AVAX than the debt:
     *              Alpha homora will repay the debt by swapping part of the want to AVAX, we
     *              need to reduce the expected return amount of want by how much we will have to repay
     * @param _collateral lp value of position
     * @param _debts debts to repay (should always be AVAX)
     */
    function _calcAvailable(uint256 _positionId, uint256 _collateral)
        private
        view
        returns (uint256[] memory, uint256)
    {
        uint256 posWant;
        (uint256[] memory lpPosition, int256 AVAXPosition) = _calcAVAXPosition(_positionId, _collateral);
        if (AVAXPosition > 0) {
            posWant =
                _uniPrice(uint256(AVAXPosition), wavax)[1] +
                lpPosition[1];
            lpPosition[0] = uint256(AVAXPosition);
        } else {
            lpPosition[1] -= _uniPrice(uint256(AVAXPosition * -1), wavax)[1];
            lpPosition[0] = 0;
            posWant = lpPosition[1];
        }
        return (lpPosition, posWant);
    }

    /*
     * @notice Calculate estimated amount of want the strategy holds
     * @param _positionId active position
     */
    function _calcEstimatedWant(uint256 _positionId)
        private
        view
        returns (uint256)
    {
        PositionData storage pd = positions[_positionId];
        (, uint256 estWant) = _calcAvailable(_positionId, pd.collateral);
        return estWant;
    }

    /*
     * @notice Calculate the amount of avax the strategy has in excess/owes 
     *      to Alpha Homora
     * @param _positionId active position 
     * @param _collateral amount of collateral the strategy holds
     * @return value of collateral and avax (excess or owed)
     */
    function _calcAVAXPosition(uint256 _positionId, uint256 _collateral) 
        private
        view
        returns (uint256[] memory, int256)
    {
        if (_positionId == 0) return (new uint256[](2), 0);
        (, uint256[] memory debts) = IHomora(homoraBank).getPositionDebts(
            _positionId
        );
        uint256[] memory lpPosition = _calcLpPosition(_collateral);
        int256 AVAXPosition = int256(lpPosition[0]) - int256(debts[0]);

        return (lpPosition, AVAXPosition);
    }

    /*
     * @notice determine if the strategy is short/long on avax and if this is outside
     *      an acceptable threshold.
     * @param _positionId active position
     * @param _collateral amount of collateral the strategy holds
     * @return if avax exposure to high, if strategy is short or long in avax and the
     *      amount the strategy intends to remove if it would adjust itself.
     */
    function _calcAVAXExposure(uint256 _positionId, uint256 _collateral)
        private
        view
        returns (bool, bool, uint256[] memory)
    {
        (uint256[] memory lpPosition, int256 AVAXPosition) = _calcAVAXPosition(_positionId, _collateral);
        bool short;
        if (AVAXPosition < 0) {
            short = true;
            AVAXPosition = AVAXPosition * -1;
        }
        if (compare(uint256(AVAXPosition), lpPosition[0], exposureThreshold)) {
            uint256 ratio = (uint256(AVAXPosition) * adjustRatio) / lpPosition[0];
            lpPosition[0] = lpPosition[0] * ratio / PERCENTAGE_DECIMAL_FACTOR;
            lpPosition[1] = lpPosition[1] * ratio / PERCENTAGE_DECIMAL_FACTOR;
            return (true, short, lpPosition);
        }
    }

    /*//////////////////////////
     *    Other logic
     *//////////////////////////

    /*
     * @notice Estimate price of yield tokens
     * @param _positionId ID active position
     * @param _balance contracts current yield token balance
     */
    function _valueOfYieldToken(uint256 _positionId, uint256 _balance)
        internal
        view
        returns (uint256)
    {
        uint256 estimatedYieldToken = pendingYieldToken(_positionId) + _balance;
        if (estimatedYieldToken > 0) {
            uint256[] memory yieldTokenWantValue = _uniPrice(
                estimatedYieldToken,
                yieldToken
            );
            return yieldTokenWantValue[yieldTokenWantValue.length - 1];
        } else {
            return 0;
        }
    }

    /*
     * @notice create path for uniswap style router
     * @dev if there is no direct path for the token pair, the intermidiate
     *      path (avax) will be taken before going to want
     */
    function _getPath(address _start) private view returns (address[] memory) {
        address[] memory path;
        if (_start == wavax) {
            path = new address[](2);
            path[0] = wavax;
            path[1] = address(want);
        } else if (_start == address(want)) {
            path = new address[](2);
            path[0] = address(want);
            path[1] = wavax;
        } else {
            if (indirectPath == address(0)) {
                path = new address[](2);
                path[0] = yieldToken;
                path[1] = address(want);
            } else {
                path = new address[](3);
                path[0] = yieldToken;
                path[1] = indirectPath;
                path[2] = address(want);
            }
        }
        return path;
    }

    /**
     * @notice
     *  Provide a signal to the keeper that `harvest()` should be called. The
     *  keeper will provide the estimated gas cost that they would pay to call
     *  `harvest()`, and this function should use that estimate to make a
     *  determination if calling it is "worth it" for the keeper. This is not
     *  the only consideration into issuing this trigger, for example if the
     *  position would be negatively affected if `harvest()` is not called
     *  shortly, then this can return `true` even if the keeper might be "at a
     *  loss".
     * @dev
     *  `_callCost` must be priced in terms of `want`.
     *
     *  It is expected that an external system will check `harvestTrigger()`.
     *  This could be a script run off a desktop or cloud bot.
     * @param _callCost The keeper's estimated cast cost to call `harvest()`.
     * @return `true` if `harvest()` should be called, `false` otherwise.
     */
    function harvestTrigger(uint256 _callCost)
        external
        view
        override
        returns (bool)
    {
        // Should not trigger if Strategy is not activated
        if (vault.strategies(address(this)).activation == 0) return false;

        // external view function, so we dont bother setting activePosition to a local variable
        if (!_ammCheck(decimals, address(want))) return false;
        (bool check, uint256 remainingLimit) = _checkPositionHealth(
            activePosition
        );
        if (check) return true;
        if (activePosition > 0) {
            (check, , ) = _calcAVAXExposure(activePosition, positions[activePosition].collateral);
            if (check) return true;
        }

        // If some amount is owed, pay it back
        // NOTE: Since debt is based on deposits, it makes sense to guard against large
        //       changes to the value from triggering a harvest directly through user
        //       behavior. This should ensure reasonable resistance to manipulation
        //       from user-initiated withdrawals as the outstanding debt fluctuates.
        uint256 outstanding = vault.debtOutstanding();
        if (outstanding > debtThreshold) return true;

        // Otherwise, only trigger if it "makes sense" economically
        uint256 credit = vault.creditAvailable();
        // Check if we theres enough assets to add to/open a new position
        if (remainingLimit >= minWant) {
            if (credit + want.balanceOf(address(this)) >= minWant) {
                return true;
            }
        }
        if (address(this).balance > 0) return true;
        return false;
    }

    /**
     * @notice
     *  Harvests the Strategy, recognizing any profits or losses and adjusting
     *  the Strategy's position.
     *
     *  In the rare case the Strategy is in emergency shutdown, this will exit
     *  the Strategy's position.
     *
     * @dev
     *  When `harvest()` is called, the Strategy reports to the Vault (via
     *  `vault.report()`), so in some cases `harvest()` must be called in order
     *  to take in profits, to borrow newly available funds from the Vault, or
     *  otherwise adjust its position. In other cases `harvest()` must be
     *  called to report to the Vault on the Strategy's position, especially if
     *  any losses have occurred. For the AHv2 strategy, the order of which
     *  accounting vs. position changes are made depends on if the position
     *  will be closed down or not.
     */
    function harvest() external override {
        require(msg.sender == address(vault), "!vault");
        uint256 profit = 0;
        uint256 loss = 0;
        uint256 debtOutstanding = vault.debtOutstanding();
        uint256 debtPayment = 0;

        // Check if position needs to be closed before accounting
        uint256 positionId = activePosition;
        (bool adjustFirst, uint256 remainingLimit) = _checkPositionHealth(positionId);
        if (emergencyExit) {
            // Free up as much capital as possible
            (uint256 totalAssets, ) = _estimatedTotalAssets(positionId);
            // NOTE: use the larger of total assets or debt outstanding to book losses properly
            (debtPayment, loss) = _liquidatePosition(
                totalAssets > debtOutstanding ? totalAssets : debtOutstanding
            );
            // NOTE: take up any remainder here as profit
            if (debtPayment > debtOutstanding) {
                profit = debtPayment - debtOutstanding;
                debtPayment = debtOutstanding;
            }
            positionId = 0;
        } else {
            require(_ammCheck(decimals, address(want)), "!ammCheck");
            // Free up returns for Vault to pull
            if (adjustFirst) {
                _adjustPosition(positionId, adjustFirst, remainingLimit);
            }
            (profit, loss, debtPayment, positionId) = _prepareReturn(debtOutstanding);
        }
        // Allow Vault to take up to the "harvested" balance of this contract,
        // which is the amount it has earned since the last time it reported to
        // the Vault.
        debtOutstanding = vault.report(profit, loss, debtPayment);

        // Check if free returns are left, and re-invest them
        if (!adjustFirst) {
            _adjustPosition(positionId, adjustFirst, remainingLimit);
        }
        emit LogHarvested(profit, loss, debtPayment, debtOutstanding);
    }

    // compare if the BP ratio between two value is GT or EQ to a target
    function compare(uint256 a, uint256 b, uint256 target) private view returns (bool) {
        return a * PERCENTAGE_DECIMAL_FACTOR / b >= target;
    }

    /*
     * @notice prepare this strategy for migrating to a new
     * @param _newStrategy address of migration target (not used here)
     */
    function _prepareMigration(address _newStrategy) internal override {
        require(activePosition == 0, "active position");
        require(address(this).balance == 0, "avax > 0");
    }
}
