// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../BaseStrategy.sol";
import "../common/Constants.sol";
import "hardhat/console.sol";

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

interface ICurve {
    function exchange_underlying(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    function get_dy_underlying(
        int128 i,
        int128 j,
        uint256 dx
    ) external view returns (uint256);
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
 *  If the collateral factor move away from the ideal target, the strategy won't take on more debt from alpha
 *  homora when adding assets to the position.
 */
contract AHv2FarmerDai is BaseStrategy {
    using SafeERC20 for IERC20;

    // Base constants
    uint256 public constant DEFAULT_DECIMALS_FACTOR = 1E18;
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
    address public constant homoraBank =
        address(0x376d16C7dE138B01455a51dA79AD65806E9cd694);
    address public constant masterChef =
        address(0xd6a4F121CA35509aF06A0Be99093d08462f53052);
    IWMasterChef public constant wMasterChef =
        IWMasterChef(0xB41DE9c1f50697cC3Fd63F24EdE2B40f6269CBcb);
    ICurve public constant curvePool =
        ICurve(0x7f90122BF0700F9E7e1F688fe926940E8839F353);
    address public immutable spell;

    // strategies current position
    uint256 public activePosition;
    // How much change we accept in AVAX price before closing or adjusting the position
    uint256 public ilThreshold = 400; // 4%
    uint256 public slippage = 10; // 0.1% curve slippage

    // In case no direct path exists for the swap, use this token as an inermidiary step
    address public immutable indirectPath;
    // liq. pool token order, used to determine if calculations should be reversed or not
    // first token in liquidity pool
    address public immutable tokenA;
    // second token in liquidity pool
    address public immutable tokenB;

    // Min amount of tokens to open/adjust positions or sell
    uint256 public minWant;
    mapping(address => uint256) public ammThreshold;

    // Limits the size of a position based on how much is available to borrow
    uint256 public borrowLimit;

    event LogNewPositionOpened(
        uint256 indexed positionId,
        uint256[] price,
        uint256 collateralSize,
        uint256[] debts
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
        uint256[] debts,
        bool withdrawal
    );

    event LogAVAXSold(uint256[] AVAXSold);

    event NewFarmer(
        address vault,
        address spell,
        address router,
        address pool,
        uint256 poolId
    );
    event LogNewReserversSet(uint256 reserve);

    event LogNewIlthresholdSet(uint256 ilThreshold);
    event LogNewSlippage(uint256 slippage);
    event LogNewMinWantSet(uint256 minWawnt);
    event LogNewBorrowLimit(uint256 newLimit);
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

    // strategy positions
    mapping(uint256 => PositionData) positions;

    // function headers for generating signatures for encoding function calls
    // AHv2 homorabank uses encoded spell function calls in order to cast spells
    string constant spellOpen =
        "addLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)";
    string constant spellClose =
        "removeLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256))";

    // poolId for masterchef - can be commented out for non sushi spells
    uint256 immutable poolId;

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
        IERC20(_indirectPath).safeApprove(address(curvePool), type(uint256).max);
        spell = _spell;
        uniSwapRouter = IUni(_router);
        pool = IUniPool(_pool);
        poolId = _poolId;
        emit NewFarmer(_vault, _spell, _router, _pool, _poolId);
    }

    /// Strategy name
    function name() external pure override returns (string memory) {
        return "AHv2 strategy";
    }

    // Strategy will recieve AVAX from closing/adjusting positions, do nothing with the AVAX here
    receive() external payable {}

    // Default getter for public structs dont return dynamics arrays, so we add this here
    function getPosition(uint256 _positionId)
        external
        view
        returns (PositionData memory)
    {
        return positions[_positionId];
    }

    /*
     * @notice set minimum want required to adjust position
     * @param _minWant minimum amount of want
     */
    function setMinWant(uint256 _minWant) external onlyOwner {
        minWant = _minWant;
        emit LogNewMinWantSet(_minWant);
    }

    /*
     * @notice set curve slippage
     * @param _slippage new curve slippage
     */
    function setSlippage(uint256 _slippage) external onlyOwner {
        require(_slippage < 1000, 'setSlippage: slippage > 10%');
        slippage = _slippage;
        emit LogNewSlippage(_slippage);
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
     * @notice set impermanent loss threshold - this indicates when a position should be closed or adjusted
     *  based on price differences between the original position and
     * @param _newThreshold new il threshold
     */
    function setIlThreshold(uint256 _newThreshold) external onlyOwner {
        require(_newThreshold <= 10000, "setIlThreshold: !newThreshold");
        ilThreshold = _newThreshold;
        emit LogNewIlthresholdSet(_newThreshold);
    }

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
        require(_ammCheck(decimals, address(want)), "_openPosition: !ammCheck");
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
        (, uint256[] memory debts) = IHomora(homoraBank).getPositionDebts(
            _positionId
        );

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
                collateralSize,
                debts
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
                debts,
                _withdraw
            );
        }
    }

    /*
     * @notice Manually wind down an AHv2 position
     * @param _positionId ID of position to close
     */
    function forceClose(uint256 _positionId) external onlyAuthorized {
        _closePosition(_positionId, 0, true);
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
        bool _force
    ) internal returns (uint256) {
        require(
            _ammCheck(decimals, address(want)),
            "_closePosition: !ammCheck"
        );
        // active position data
        RepayAmounts memory amt;
        uint256[] memory minAmounts;
        uint256[] memory amounts;
        uint256 collateral;
        uint256 wantBal;
        bool _partial;
        if (_amount > 0) {
            _partial = true;
            (amounts, collateral) = _calcSingleSidedLiq(_amount, true);
            minAmounts = new uint256[](2);
            minAmounts[1] =
                (amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 100)) /
                PERCENTAGE_DECIMAL_FACTOR;
            minAmounts[0] = 0;
        } else {
            PositionData storage pd = positions[_positionId];
            collateral = pd.collateral;
            (, uint256[] memory debts) = IHomora(homoraBank).getPositionDebts(
                _positionId
            );
            wantBal = want.balanceOf(address(this));
            amounts = new uint256[](2);
            if (!_force) {
                // Calculate amount we expect to get out by closing the position (applying 0.5% slippage)
                // Note, expected will be [AVAX, want], as debts always will be [AVAX] and solidity doesnt support
                // sensible operations like [::-1] or zip...
                (minAmounts, ) = _calcAvailable(
                    (collateral * (PERCENTAGE_DECIMAL_FACTOR - 50)) /
                        PERCENTAGE_DECIMAL_FACTOR,
                    debts
                );
            } else {
                minAmounts = new uint256[](2);
            }
        }
        amt = _formatClose(minAmounts, collateral, amounts[1]);
        IHomora(homoraBank).execute(
            _positionId,
            spell,
            abi.encodeWithSignature(spellClose, tokenA, tokenB, amt)
        );
        if (_partial) {
            _setPositionData(_positionId, amounts, false, true);
            return _positionId;
        } else {
            // Do not sell after closing down the position, AVAX/yieldToken are sold during
            //  the early stages for the harvest flow (see prepareReturn)
            // total amount of want retrieved from position
            wantBal = want.balanceOf(address(this)) - wantBal;
            PositionData storage pos = positions[_positionId];
            pos.timestamps.push(block.timestamp);
            pos.totalClose = wantBal;
            uint256[] memory _wantClose = _uniPrice(
                pos.wantOpen[0],
                address(want)
            );
            pos.wantClose = _wantClose;
            activePosition = 0;
            emit LogPositionClosed(_positionId, wantBal, _wantClose);
            return 0;
        }
    }

    /*
     * @notice sell the contracts AVAX for want if there enough to justify the sell
     */
    function _sellAVAX() internal {
        uint256 balance = address(this).balance;

        // check if we have enough AVAX to sell
        if (balance == 0) {
            return;
        }

        // Use a call to the uniswap router contract to swap exact AVAX for want
        // note, minwant could be set to 0 here as it doesnt matter, this call
        // cannot prevent any frontrunning and the transaction should be executed
        // using a private host. When lacking a private host it needs to rely on the
        // AMM check or ues the manual see function between harvest.
        uint256[] memory amounts = uniSwapRouter.swapExactAVAXForTokens{
            value: balance
        }(0, _getPath(indirectPath), address(this), block.timestamp);

        balance = IERC20(indirectPath).balanceOf(address(this));
        uint256 minAmount = balance * 10 ** (18 - 6) * (PERCENTAGE_DECIMAL_FACTOR - slippage) / PERCENTAGE_DECIMAL_FACTOR;
        balance = curvePool.exchange_underlying(1, 0, balance, minAmount);

        emit LogAVAXSold(amounts);
    }

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
        _repay = (_repay == 0) ? REPAY : _repay;
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
     * @notice create path for uniswap style router
     * @dev if there is no direct path for the token pair, the intermidiate
     *      path (avax) will be taken before going to want
     */
    function _getPath(address _start) private view returns (address[] memory) {
        address[] memory path = new address[](2);
        if (_start == wavax) {
            path[0] = wavax;
            path[1] = address(want);
        } else if (_start == address(want)) {
            path[0] = address(want);
            path[1] = wavax;
        } else {
            path[0] = wavax;
            path[1] = _start;

        }
        return path;
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

    function estimatedTotalAssets() public view override returns (uint256) {
        (uint256 totalAssets, ) = _estimatedTotalAssets(activePosition);
        return totalAssets;
    }

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
        uint256[] memory _valueOfAVAX = _uniPrice(address(this).balance, indirectPath);
        if (_valueOfAVAX[1] > 0) {
            _valueOfAVAX[1] = curvePool.get_dy_underlying(1, 0, _valueOfAVAX[1]);
        }
        uint256 _reserve = want.balanceOf(address(this));

        if (_positionId == 0) {
            return (
                    _valueOfAVAX[1] +
                    _reserve,
                _reserve
            );
        }
        return (
            _reserve +
                _calcEstimatedWant(_positionId) +
                _valueOfAVAX[1],
            _reserve
        );
    }

    /*
     * @notice expected profit/loss of the strategy
     */
    function expectedReturn() external view returns (uint256) {
        uint256 totalAssets = estimatedTotalAssets();
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

    /*
     * @notice Calculate strategies current loss, profit and amount if can repay
     * @param _debtOutstanding amount of debt remaining to be repaid
     */
    function _prepareReturn(uint256 _debtOutstanding)
        internal
        override
        returns (
            uint256 _profit,
            uint256 _loss,
            uint256 _debtPayment
        )
    {
        uint256 _positionId = activePosition;
        uint256 balance;
        // only try to realize profits if there is no active position
        if (_positionId == 0 || _debtOutstanding > 0) {
            _sellAVAX();
            balance = want.balanceOf(address(this));
            if (balance < _debtOutstanding) {
                // withdraw to cover the debt
                if (
                    (_debtOutstanding * PERCENTAGE_DECIMAL_FACTOR) /
                        (positions[_positionId].wantOpen[0] + balance) >=
                    8000
                ) {
                    balance = 0;
                } else {
                    balance = _debtOutstanding - balance;
                }
                _positionId = _closePosition(_positionId, balance, false);
                balance = want.balanceOf(address(this));
            }
            _debtPayment = Math.min(balance, _debtOutstanding);

            if (_positionId == 0) {
                uint256 debt = vault.strategies(address(this)).totalDebt;
                // Balance - Total Debt is profit
                if (balance > debt) {
                    _profit = balance - debt;
                    if (balance < _profit) {     
                        _profit = balance;
                    } else if (balance > _profit + _debtOutstanding){
                        _debtPayment = _debtOutstanding;
                    } else {
                        _debtPayment = balance - _profit;
                    }
                } else {
                    _loss = debt - balance;
                }

            }
        }
    }

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
        uint256 difference;
        if (openPrice[1] < currentPrice[1]) {
            difference =
                ((currentPrice[1] * PERCENTAGE_DECIMAL_FACTOR) / openPrice[1]) -
                PERCENTAGE_DECIMAL_FACTOR;
        } else {
            difference =
                ((openPrice[1] * PERCENTAGE_DECIMAL_FACTOR) / currentPrice[1]) -
                PERCENTAGE_DECIMAL_FACTOR;
        }
        if (difference >= ilThreshold) return true;
        return false;
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
    function _calcAvailable(uint256 _collateral, uint256[] memory _debts)
        private
        view
        returns (uint256[] memory, uint256)
    {
        uint256[] memory lpPosition = _calcLpPosition(_collateral);
        uint256 posWant;
        int256 AVAXPosition = int256(lpPosition[0]) - int256(_debts[0]);

        if (AVAXPosition > 0) {
            posWant =
                curvePool.get_dy_underlying(1, 0, _uniPrice(uint256(AVAXPosition), indirectPath)[1]) +
                lpPosition[1];
            lpPosition[0] = uint256(AVAXPosition);
        } else {
            lpPosition[1] -= _uniPrice(uint256(AVAXPosition * -1), wavax)[1];
            lpPosition[0] = 0;
            posWant = lpPosition[1];
        }
        return (lpPosition, posWant);
    }

    function _calcEstimatedWant(uint256 _positionId)
        private
        view
        returns (uint256)
    {
        PositionData storage pd = positions[_positionId];
        (, uint256[] memory debts) = IHomora(homoraBank).getPositionDebts(
            _positionId
        );
        (, uint256 estWant) = _calcAvailable(pd.collateral, debts);
        return estWant;
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
                if ((remainder * PERCENTAGE_DECIMAL_FACTOR) / assets >= 8000) {
                    _closePosition(_positionId, 0, false);
                    _sellAVAX();
                } else {
                    _closePosition(_positionId, remainder, false);
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
    function _adjustPosition(uint256 _debtOutstanding) internal override {
        //emergency exit is dealt with in liquidatePosition
        if (emergencyExit) {
            return;
        }

        uint256 _positionId = activePosition;
        (bool check, uint256 remainingLimit) = _checkPositionHealth(
            activePosition
        );
        if (check) {
            _closePosition(_positionId, 0, false);
            return;
        }
        //we are spending all our cash unless we have debt outstanding
        uint256 wantBal = want.balanceOf(address(this));

        // check if the current want amount is large enough to justify opening/adding
        // to an existing position, else do nothing
        if (wantBal > remainingLimit) wantBal = remainingLimit;
        if (wantBal >= minWant) {
            if (_positionId == 0) {
                _openPosition(true, 0, wantBal);
            } else {
                // TODO logic to lower the colateral ratio
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
        }
    }

    /*
     * @notice prepare this strategy for migrating to a new
     * @param _newStrategy address of migration target (not used here)
     */
    function _prepareMigration(address _newStrategy) internal override {
        require(activePosition == 0, "prepareMigration: active position");
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
        console.log('ammCheck');
        console.log('AH %s TJ %s', ((ethPx * 10**(_decimals + 4)) / 2**112), amounts[1]);
        diff = (diff > PERCENTAGE_DECIMAL_FACTOR)
            ? diff - PERCENTAGE_DECIMAL_FACTOR
            : PERCENTAGE_DECIMAL_FACTOR - diff;
        console.log('diff %s threshold %s', diff, ammThreshold[_start]);
        // check the difference against the ammThreshold
        if (diff < ammThreshold[_start]) return true;
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
        require(msg.sender == address(vault), "harvest: !vault");
        uint256 profit = 0;
        uint256 loss = 0;
        uint256 debtOutstanding = vault.debtOutstanding();
        uint256 debtPayment = 0;

        // Check if position needs to be closed before accounting
        (bool adjustFirst, ) = _checkPositionHealth(activePosition);
        if (emergencyExit) {
            // Free up as much capital as possible
            uint256 totalAssets = estimatedTotalAssets();
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
            if (adjustFirst) {
                _adjustPosition(debtOutstanding);
            }
            (profit, loss, debtPayment) = _prepareReturn(debtOutstanding);
        }
        // Allow Vault to take up to the "harvested" balance of this contract,
        // which is the amount it has earned since the last time it reported to
        // the Vault.
        debtOutstanding = vault.report(profit, loss, debtPayment);

        // Check if free returns are left, and re-invest them
        if (!adjustFirst) {
            _adjustPosition(debtOutstanding);
        }

        emit LogHarvested(profit, loss, debtPayment, debtOutstanding);
    }

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
        public
        view
        override
        returns (bool)
    {
        StrategyParams memory params = vault.strategies(address(this));

        // Should not trigger if Strategy is not activated
        if (params.activation == 0) return false;

        // external view function, so we dont bother setting activePosition to a local variable
        (bool check, uint256 remainingLimit) = _checkPositionHealth(
            activePosition
        );
        if (check) return true;

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
        return false;
    }
}
