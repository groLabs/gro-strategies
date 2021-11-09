// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "../BaseStrategy.sol";
import "../common/Constants.sol";

// Uniswap router interface
interface IUni{
    function getAmountsOut(
        uint256 _amountIn, 
        address[] calldata _path
    ) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 _amountIn,
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    ) external returns (uint256[] memory amounts);
}

// Uniswap pool interface
interface IUniPool{
    function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast);
    function totalSupply() external view returns (uint256);
}

// HomoraBank interface
interface IHomora {
    function execute(uint _positionId, address _spell, bytes memory _data) external payable returns (uint256);
    function nextPositionId() external view returns (uint256);
    function borrowBalanceStored(uint256 _positionId, address _token) external view returns (uint256);
    function getPositionInfo(uint256 _positionId) external view 
        returns (
            address owner,
            address collToken,
            uint collId,
            uint collateralSize
        );
    function getPositionDebts(uint256 _positionId) external view
        returns (
            address[] memory tokens,
            uint[] memory debts
        );
    function getCollateralETHValue(uint256 _positionId) external view returns (uint256);
    function getBorrowETHValue(uint256 _positionId) external view returns (uint256);
}

// AH master chef tracker interface
interface IWMasterChef {
    function balanceOf(address _account, uint256 _id) external view returns (uint256);
    function decodeId(uint256 _id) external pure returns (uint256 pid, uint256 sushiPerShare);
}

// Master chef interface
interface IMasterChef {
    function poolInfo(uint256 _pid) external view returns (
        address lpToken,
        uint allocPoint,
        uint lastRewardBlock,
        uint accSushiPerShare
    );
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
 *  If the collateral factor move away from the ideal target, the strategy won't take on more debt from alpha
 *  homora when adding assets to the position.
 */
contract AHv2Farmer is BaseStrategy {
    using SafeERC20 for IERC20;

    // Base constants
    uint256 public constant DEFAULT_DECIMALS_FACTOR = 1E18;
    uint256 public constant PERCENTAGE_DECIMAL_FACTOR = 1E4;
    // collateral constants - The collateral ratio is calculated by using
    // the homoraBank to establish the eth value of the debts vs the eth value
    // of the collateral.
    // !!!Change these to constant values - these are left as non constant for testing purposes!!!
    uint256 public targetCollateralRatio = 7950; // ideal collateral ratio
    uint256 public collateralThreshold = 8900; // max collateral raio
    // LP Pool token
    IUniPool public immutable pool;
    address public constant weth = address(0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7);
    // Full repay
    uint256 constant REPAY = type(uint256).max;
    
    // Uni or Sushi swap router
    address public immutable uniSwapRouter;
    // comment out if uniSwap spell is used
    address public constant sushi = address(0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd);
    address public constant homoraBank = address(0x376d16C7dE138B01455a51dA79AD65806E9cd694);
    address public constant masterChef = address(0xd6a4F121CA35509aF06A0Be99093d08462f53052);
    IWMasterChef public constant wMasterChef = IWMasterChef(0xB41DE9c1f50697cC3Fd63F24EdE2B40f6269CBcb);
    address public immutable spell;

    // strategies current position
    uint256 public activePosition;
    // How much change we accept in eth price before closing or adjusting the position
    uint256 public ilThreshold;

    // Min amount of tokens to open/adjust positions or sell
    uint256 public minWant;
    uint256 public constant minEthToSell = 0;
    // comment out if uniSwap spell is used
    uint256 public constant minSushiToSell = 0;

    event LogNewPositionOpened(uint256 positionId, uint256[] price, uint256 collateralSize, uint256[] debts);
    event LogPositionClosed(uint256 positionId, uint256 wantRecieved, uint256[] price);
    event LogPositionAdjusted(uint256 positionId, uint256[] amounts, uint256 collateralSize, uint256[] debts, bool withdrawal);
    event LogEthSold(uint256[] ethSold);
    event LogSushiSold(uint256[] sushiSold);

    event NewFarmer(address vault, address spell, address router, address pool, uint256 poolId);
    event LogNewReserversSet(uint256 reserve);
    event LogNewIlthresholdSet(uint256 ilThreshold);
    event LogNewMinWantSet(uint256 minWawnt);


    struct positionData {
        uint256[] wantClose; // eth value of position when closed [want => eth]
        uint256 totalClose; // total value of position on close
        uint256[] wantOpen; // eth value of position when opened [want => eth]
        address collToken; // collateral token 
        uint256 collId; // collateral ID
        uint256 collateral; // collateral amount
        address[] debtTokens; // borrowed tokens 
        uint256[] debt; // borrowed token amount
        bool active; // is position active
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
    mapping(uint256 => positionData) positions;

    // function headers for generating signatures for encoding function calls
    // AHv2 homorabank uses encoded spell function calls in order to cast spells
    string constant sushiOpen = 'addLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)';
    string constant sushiClose = 'removeLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256))';
    // function for selling eth for want (uniswap router)
    string constant ethForTokens = 'swapExactAVAXForTokens(uint256,address[],address,uint256)';

    // poolId for masterchef - can be commented out for non sushi spells
    uint256 immutable poolId;

    constructor(address _vault,
                address _spell,
                address _router,
                address _pool,
                uint256 _poolId
    ) BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        // approve the homora bank to use our want
        want.safeApprove(homoraBank, type(uint256).max);
        // approve the router to user our sushi
        IERC20(sushi).safeApprove(_router, type(uint256).max);
        spell = _spell;
        uniSwapRouter = _router;
        pool = IUniPool(_pool);
        poolId = _poolId;

        uint256 _minWant = 10000 * (10 ** VaultAPI(_vault).decimals());
        minWant = 0; // dont open or adjust a position unless more than 10000 want
        ilThreshold = 400; // 4%
        emit NewFarmer(_vault, _spell, _router, _pool, _poolId);
        emit LogNewMinWantSet(_minWant);
        emit LogNewIlthresholdSet(400);
    }

    /// Strategy name
    function name() external pure override returns (string memory) {
        return "AHv2 strategy";
    }
        
    // Strategy will recieve eth from closing/adjusting positions, do nothing with the eth here
    receive() external payable {}

    /*
     * @notice set minimum want required to adjust position 
     * @param _minWant minimum amount of want
     */
    function setMinWant(uint256 _minWant) external onlyOwner {
        minWant = _minWant;
        emit LogNewMinWantSet(_minWant);
    }

    /*
     * @notice set impermanent loss threshold - this indicates when a position should be closed or adjusted 
     *  based on price differences between the original position and 
     * @param _newThreshold new il threshold
     */
    function setIlThreshold(uint256 _newThreshold) external onlyOwner {
        require(_newThreshold <= 10000, 'setIlThreshold: !newThreshold');
        ilThreshold = _newThreshold;
        emit LogNewIlthresholdSet(_newThreshold);
    }

    /*
     * @notice Estimate amount of sushi tokens that will be claimed if position is closed
     * @param _positionId ID of a AHv2 position
     */
    function pendingSushi(uint256 _positionId) public view returns (uint256) {
        if (_positionId == 0) {
            return 0;
        }
        uint256 _collId = positions[_positionId].collId;
        // get balance of collateral
        // uint256 amount = wChef.balanceOf(homoraBank, _collId);
        uint256 amount =  positions[_positionId].collateral;
        (uint256 pid, uint256 stSushiPerShare) = wMasterChef.decodeId(_collId);
        (, , , uint256 enSushiPerShare) = IMasterChef(masterChef).poolInfo(pid);
        uint256 stSushi = (stSushiPerShare * amount - 1) / 1e12;
        uint256 enSushi = enSushiPerShare * amount / 1e12;
        if (enSushi > stSushi) {
            return enSushi - stSushi;
        }
        return 0;
    }


    /*
     * @notice Estimate price of sushi tokens
     * @param _positionId ID active position
     * @param _balance contracts current sushi token balance
     */
    function _valueOfSushi(uint256 _positionId, uint256 _balance) internal view returns (uint256) {
        uint256 estimatedSushi = pendingSushi(_positionId) + _balance;
        if (estimatedSushi > 0 ) {
            uint256[] memory sushiWantValue = _uniPrice(estimatedSushi, sushi);
            return sushiWantValue[1];
        } else {
            return 0;
        }
    }

    /*
     * @notice make an adjustment to the current position - this will either add to or remove assets
     *      from the current position.
     *      Removing from position:
     *          Removals will occur when the vault adapter atempts to withdraw assets from the strategy,
     *          the position will attempt to withdraw only want. If eth ends up being withdrawn, this will
     *          not be sold when adjusting the position.
     *      Adding to position:
     *          If additional funds have been funneled into the strategy, and a position already is running,
     *          the strategy will add the available funds to the strategy. This adjusts the current position
     *          impermanent loss and the positions price in relation to calculate the ilThreshold
     * @param _positionId ID of active position
     * @param amounts amount to adjust position by [want, eth], when withdrawing we will atempt to repay
     *      the eth amount, when adding we will borrow this amount
     * @param _collateral collateral to remove (0 if adding to position)
     * @param _borrow Will we atempt to borrow when adding to the position
     * @param _withdraw Will we add to or remove assets from the position
     */
    function _adjustPosition(
        uint256 _positionId,
        uint256[] memory _amounts,
        uint256 _collateral,
        bool _borrow,
        bool _withdraw
    ) internal {
        // adjust by removing
        if (_withdraw) {
            uint256[] memory minAmounts = new uint256[](2);
            // AHv2 std slippage = 100 BP
            minAmounts[1] = _amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;
            minAmounts[0] = 0;

            // minAmount we want to get out, collateral we will burn and amount we want to repay
            RepayAmounts memory amt = _formatClose(minAmounts, _collateral, _amounts[1]);
            IHomora(homoraBank).execute(
                    _positionId,
                    spell,
                    abi.encodeWithSignature(sushiClose, address(want), weth, amt)
            );
        // adjust by adding
        } else {
            Amounts memory amt = _formatOpen(_amounts, _borrow);
            IHomora(homoraBank).execute(
                _positionId,
                spell,
                abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
            );
        }
        // update the position data
        _setPositionData(_positionId, _amounts, false, _withdraw);
    }

    /*
     * @notice Open a new AHv2 position with market neutral leverage
     * @param amount amount of want to provide to prosition
     */
    function _openPosition(uint256 _amount) internal {
        (uint256[] memory amounts, ) = _calcSingleSidedLiq(_amount, false);
        Amounts memory amt = _formatOpen(amounts, true);
        uint256 positionId = IHomora(homoraBank).execute(
                0,
                spell,
                abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
        );
        _setPositionData(positionId, amounts, true, false);
    }
    
    /*
     * @notice Create or update the position data for indicated position
     * @param _positionId ID of position
     * @param _amounts Amounts add/withdrawn from position
     * @param _newPosition Is the position a new one 
     * @param _withdraw Was the action a withdrawal
     */
    function _setPositionData(uint256 _positionId, uint256[] memory _amounts, bool _newPosition, bool _withdraw) internal {
        // get position data
        (, address collToken, uint256 collId, uint256 collateralSize) = IHomora(homoraBank).getPositionInfo(_positionId);
        (address[] memory tokens, uint[] memory debts) = IHomora(homoraBank).getPositionDebts(_positionId);

        positionData storage pos = positions[_positionId];
        if (_newPosition) {
            activePosition = _positionId;
            pos.active = true;
            pos.debtTokens = tokens;
            pos.collToken = collToken;
            pos.wantOpen = _amounts;
            pos.collId = collId;
            pos.collateral = collateralSize;
            pos.debt = debts;
            emit LogNewPositionOpened(_positionId, _amounts, collateralSize, debts);
        } else {
            if (!_withdraw) {
                // previous position price
                uint256[] memory _openPrice = pos.wantOpen;
                _openPrice[0] += _amounts[0];
                _openPrice[1] += _amounts[1];
                pos.wantOpen = _openPrice;
            }
            pos.collateral = collateralSize;
            pos.debt = debts;
            emit LogPositionAdjusted(_positionId, _amounts, collateralSize, debts, _withdraw);
        }
    }

    /*
     * @notice Force close the AHv2 position, here to be used if something goes horribly wrong
     * @param _positionId ID of position to close
     */
    function panicClose(uint256 _positionId) external onlyAuthorized {
        _closePosition(_positionId, true);
    }

    /*
     * @notice Close and active AHv2 position 
     * @param _positionId ID of position to close
     * @param _force Force close position, set minAmount to 0/0
     */
    function _closePosition(uint256 _positionId, bool _force) internal {
        // active position data
        positionData storage pd = positions[_positionId];
        uint256 collateral = pd.collateral;
        RepayAmounts memory amt;
        if (!_force) {
            uint256[] memory debts = pd.debt;
            // Calculate amount we expect to get out by closing the position
            // Note, expected will be [eth, want], as debts always will be [eth] and solidity doesnt support 
            // sensible operations like [::-1] or zip...
            amt = _formatClose(_calcAvailable(collateral, debts), collateral, 0);
        } else {
            amt = _formatClose(new uint256[](2), collateral, 0);
        }
        uint256 wantBal = want.balanceOf(address(this));
        IHomora(homoraBank).execute(
                _positionId,
                spell,
                abi.encodeWithSignature(sushiClose, address(want), weth, amt)
        );
        // Do not sell after closing down the position, eth/sushi are sold during
        //  the early stages for the harvest flow (see prepareReturn)
        // total amount of want retrieved from position
        wantBal = want.balanceOf(address(this)) - wantBal;
        positionData storage pos = positions[_positionId];
        pos.active = false;
        pos.totalClose = wantBal;
        uint256[] memory _wantClose = _uniPrice(pos.wantOpen[0], address(want));
        pos.wantClose = _wantClose;
        activePosition = 0;
        emit LogPositionClosed(_positionId, wantBal, _wantClose);
    }

    /*
     * @notice sell the contracts eth for want if there enough to justify the sell
     * @param _useMinThreshold Use min threshold when selling, or sell everything
     */
    function _sellEth(bool _useMinThreshold) internal returns (uint256[] memory) {
        uint256 balance = address(this).balance;

        // check if we have enough eth to sell
        if (balance == 0) return new uint256[](2);
        else if (_useMinThreshold && (balance < minEthToSell)) return new uint256[](2);
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(want);

        uint256[] memory amounts = _uniPrice(balance, weth);
        // Use a call to the uniswap router contract to swap exact eth for want
        // note, minwant could be set to 0 here as it doesnt matter, this call
        // cannot prevent any frontrunning and the transaction should be executed
        // using a private host.
        (bool success, ) = uniSwapRouter.call{value: balance}(
            abi.encodeWithSignature(ethForTokens, 0, path, address(this), block.timestamp)
        );
        require(success, '_sellEth: Eth swap to want failed');
        emit LogEthSold(amounts);
        return amounts;
        
    }

    /*
     * @notice sell the contracts sushi for want if there enough to justify the sell - can remove this method if uni swap spell
     * @param _useMinThreshold Use min threshold when selling, or sell everything
     */
    function _sellSushi(bool _useMinThreshold) internal returns (uint256[] memory) {
        uint256 balance = IERC20(sushi).balanceOf(address(this));
        if (balance == 0) return new uint256[](2);
        else if (_useMinThreshold && (balance < minSushiToSell)) return new uint256[](2);
        address[] memory path = new address[](2);
        path[0] = sushi;
        path[1] = address(want);

        uint256[] memory amounts = _uniPrice(balance, sushi);
        IUni(uniSwapRouter).swapExactTokensForTokens(amounts[0], 0, path, address(this), block.timestamp);
        emit LogSushiSold(amounts);
        return amounts;
    }

    /*
     * @notice format the open position input struct
     * @param _amounts Amounts for position
     * @param _borrow Decides if we want to borrow ETH or not
     */
    function _formatOpen(uint256[] memory _amounts, bool _borrow) internal pure returns (Amounts memory amt) {
        amt.aUser = _amounts[0];
        // Unless we borrow we only supply a value for the want we provide
        if (_borrow) {
            amt.bBorrow = _amounts[1];
        } 
        // apply 100 BP slippage
        // NOTE: Temp fix to handle adjust position without borrow 
        //      - As these transactions are run behind a private node or flashbot, it shouldnt 
        //      impact anything to set minaAmount to 0
        amt.aMin = 0;
        amt.bMin = 0;
        // amt.aMin = amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;
        // amt.bMin = amounts[1] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;
    }

    /*
     * @notice format the close position input struct
     * @param _expect expected return amounts
     * @param _collateral collateral to remove from position
     * @param _repay amount to repay - default to max value if closing position
     */
    function _formatClose(uint256[] memory _expected, uint256 _collateral, uint256 _repay) internal pure returns (RepayAmounts memory amt) {
        _repay = (_repay == 0) ? REPAY : _repay;
        amt.lpTake = _collateral;
        amt.bRepay = _repay;
        amt.aMin = _expected[1];
        amt.bMin = _expected[0];
    }

    /*
     * @notice calculate want and eth value of lp position
     *      value of lp is defined by (in uniswap routerv2):
     *          lp = Math.min(input0 * poolBalance / reserve0, input1 * poolBalance / reserve1)
     *      which in turn implies:
     *          input0 = reserve0 * lp / poolBalance
     *          input1 = reserve1 * lp / poolBalance
     * @param _collateral lp amount
     * @dev Note that we swap the order of want and eth in the return array, this is because
     *      the debt position always will be in eth, and to save gas we dont add a 0 value for the
     *      want debt. So when doing repay calculations we need to remove the debt from the eth amount,
     *      which becomes simpler if the eth position comes first.
     */
    function _calcLpPosition(uint256 _collateral) internal view returns (uint256[] memory) {
        (uint112 resA, uint112 resB, ) = IUniPool(pool).getReserves();
        uint256 poolBalance = IUniPool(pool).totalSupply();
        uint256[] memory lpPosition = new uint256[](2);

        lpPosition[1] = (_collateral * uint256(resA) * DEFAULT_DECIMALS_FACTOR / poolBalance) / DEFAULT_DECIMALS_FACTOR;
        lpPosition[0] = (_collateral * uint256(resB) * DEFAULT_DECIMALS_FACTOR / poolBalance) / DEFAULT_DECIMALS_FACTOR;

        return lpPosition;
    }

    /*
     * @notice calc want value of eth
     * @param _eth amount amount of eth
     */
    function _calcWant(uint256 _eth) private view returns (uint256) {
        uint256[] memory swap = _uniPrice(_eth, weth);
        return swap[1];
    }

    /*
     * @notice get swap price in uniswap pool
     * @param _amount amount of token to swap
     * @param _start token to swap out
     */
    function _uniPrice(uint256 _amount, address _start) internal view returns (uint256[] memory) {
        if (_amount == 0) {
            return new uint256[](2);
        }
        address[] memory path= new address[](2);
        if (_start == weth) {
            path[0] = _start;
            path[1] = address(want);
        } else {
            path[0] = _start; 
            path[1] = weth; 
        }
        uint256[] memory amounts = IUni(uniSwapRouter).getAmountsOut(_amount, path);

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
    function _estimatedTotalAssets(uint256 _positionId) private view returns (uint256, uint256) {
        // get the value of the current position supplied by this strategy (total - borrowed)
        uint256 sushiBalance = IERC20(sushi).balanceOf(address(this));
        uint256[] memory _valueOfEth = _uniPrice(address(this).balance, weth);
        uint256 _reserve = want.balanceOf(address(this));
        
        if (_positionId == 0) return (_valueOfSushi(_positionId, sushiBalance) + _valueOfEth[1] + _reserve, _reserve);
        return (_reserve + _calcEstimatedWant(_positionId) + _valueOfSushi(_positionId, sushiBalance) + _valueOfEth[1], _reserve);
    }

    /*
     * @notice expected profit/loss of the strategy
     */
    function expectedReturn() external view returns (int256) {
        return int256(estimatedTotalAssets()) - int256(vault.strategyDebt());
    }

    /*
     * @notice get collateral and borrowed eth value of position
     * @dev This value is based on Alpha homoras calculation which can
     *     be found in the homoraBank and homora Oracle (0xeed9cfb1e69792aaee0bf55f6af617853e9f29b8)
     *     (tierTokenFactors). This value can range from 0 to > 10000, where 10000 indicates liquidation
     */
    function _getCollateralFactor(uint256 _positionId) private view returns (uint256) {
        uint256 deposit = IHomora(homoraBank).getCollateralETHValue(_positionId);
        uint256 borrow =  IHomora(homoraBank).getBorrowETHValue(_positionId);
        return borrow * PERCENTAGE_DECIMAL_FACTOR / deposit;
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
        if (_positionId == 0) {
            // only try to sell if there is no active position
            _sellEth(true);
            _sellSushi(true);
            uint256 _wantBalance = want.balanceOf(address(this));
            _debtPayment = Math.min(_wantBalance, _debtOutstanding); 
            return (_profit, _loss, _debtPayment);
        }

        (uint256 balance, uint256 wantBalance) = _estimatedTotalAssets(_positionId);

        uint256 debt = vault.strategies(address(this)).totalDebt;

        // Balance - Total Debt is profit
        if (balance > debt) {
            _profit = balance - debt;

            if (wantBalance < _profit) {
                // all reserve is profit                
                _profit = wantBalance;
            } else if (wantBalance > _profit + _debtOutstanding) {
                _debtPayment = _debtOutstanding;
            } else{
                _debtPayment = wantBalance - _profit;
            }
        } else {
            _loss = debt - balance;
            _debtPayment = Math.min(wantBalance, _debtOutstanding);
        }
    }
    
    /*
     * @notice Check if price change is outside the accepted range,
     *      in which case the the opsition needs to be closed or adjusted
     */
    function volatilityCheck() public view returns(bool) {
        if (activePosition == 0) {
            return false;
        }
        uint256[] memory openPrice = positions[activePosition].wantOpen;
        (uint256[] memory currentPrice, ) = _calcSingleSidedLiq(openPrice[0], false);
        uint256 difference;
        if (openPrice[1] < currentPrice[1]) {
            difference = (currentPrice[1] * PERCENTAGE_DECIMAL_FACTOR / openPrice[1]) - PERCENTAGE_DECIMAL_FACTOR;
        } else {
            difference = (openPrice[1] * PERCENTAGE_DECIMAL_FACTOR / currentPrice[1]) - PERCENTAGE_DECIMAL_FACTOR;
        }
        if (difference >= ilThreshold) return true;
        return false;
    }

    /*
     * @notice calculate how much expected returns we will get when closing down our position,
     *      this involves calculating the value of the collateral for the position (lp),
     *      and repaying the existing debt to Alpha homora. Two potential outcomes can come from this:
     *          - the position returns more eth than debt:
     *              in which case the strategy will collect the eth and atempt to sell it
     *          - the position returns less eth than the debt:
     *              Alpha homora will repay the debt by swapping part of the want to eth, we
     *              need to reduce the expected return amount of want by how much we will have to repay
     * @param _collateral lp value of position
     * @param _debts debts to repay (should always be eth)
     */
    function _calcAvailable(uint256 _collateral, uint256[] memory _debts) private view returns (uint256[] memory) {
        // get underlying value of lp postion [eth, want]
        uint256[] memory lpPosition = _calcLpPosition(_collateral);
        uint256[] memory expected = new uint256[](2);

        // standrad AH exit applies 1% slippage to close position
        lpPosition[0] = lpPosition[0] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;
        lpPosition[1] = lpPosition[1] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;

        // if the eth debt is greater than the positions eth value, we need to reduce the the expected want by the amount
        // that will be used to repay the whole eth loan
        if (lpPosition[0] < _debts[0]) {
                uint256[] memory change = _uniPrice(_debts[0] - lpPosition[0], weth);
                expected[1] = lpPosition[1] - change[1];
                expected[0] = 0;
        } else {
            // repay eth debt
            expected[0] = lpPosition[0] - _debts[0];
            expected[1] = lpPosition[1];
        }

        return expected;
    }

    /*
     * @notice calculate how much want our collateral - debt is worth
     * @param _positionId id of position
     */
    function _calcEstimatedWant(uint256 _positionId) private view returns (uint256) {
        positionData storage pos = positions[_positionId];
        // get underlying value of lp postion [eth, want]
        uint256[] memory lpPosition = _calcLpPosition(pos.collateral);
        uint256[] memory debt = pos.debt;
        int256 ethPosition = int256(lpPosition[0]) - int256(debt[0]);
        return (ethPosition > 0) ? lpPosition[1] + _calcWant(uint256(ethPosition)) 
            : lpPosition[1] - _calcWant(uint256(ethPosition * -1));
    }

    /*
     * @notice Calculate how much eth needs to be provided for a set amount of want
     *      when adding liquidity - This is used to estimate how much to borrow from AH.
     *      We need to get amtA * resB - amtB * resA = 0 to solve the AH optimal swap
     *      formula for 0, so we use same as uniswap rouer quote function:
     *          amountA * reserveB / reserveA
     * @param _amount amount of want
     * @param _withdraw we need to calculate the liquidity amount if withdrawing
     * @dev We uesr the uniswap formula to calculate liquidity
     *          lp = Math.min(input0 * poolBalance / reserve0, input1 * poolBalance / reserve1)
     */
    function _calcSingleSidedLiq(uint256 _amount, bool _withdraw) internal view returns (uint256[] memory, uint256) {
        (uint112 reserve0, uint112 reserve1, ) = IUniPool(pool).getReserves();
        uint256[] memory amt = new uint256[](2);
        amt[1] = _amount * reserve1 / reserve0;
        amt[0] = _amount; //amt[1] * reserve0 / reserve1;
        if (_withdraw) {
            uint256 poolBalance = IUniPool(pool).totalSupply();
            uint256 liquidity = Math.min(amt[0] * poolBalance / reserve0, amt[1] * poolBalance / reserve1);
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
        returns (uint256, uint256)
    {
        uint256 _amountFreed = 0;
        uint256 _loss = 0;
        // want in contract + want value of position based of eth value of position (total - borrowed)
        uint256 _positionId = activePosition;

        (uint256 assets, uint256 _balance) = _estimatedTotalAssets(_positionId);

        uint256 debt = vault.strategyDebt();

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
                _closePosition(_positionId, false);
            }
            _sellEth(false);
            _sellSushi(false);
            _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
            return (_amountFreed, _loss);
        } else {
            // do we have enough assets in strategy to repay?
            int256 changeFactor = int256(_getCollateralFactor(_positionId)) - int256(targetCollateralRatio);
            if (_balance < _amountNeeded) {
                uint256 remainder;
                if (changeFactor > 500) {
                    _closePosition(_positionId, false);
                    _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
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
                    _closePosition(_positionId, false);
                } else {
                    (uint256[] memory repay, uint256 lpAmount) = _calcSingleSidedLiq(remainder, true);
                    _adjustPosition(_positionId, repay, lpAmount, false, true);
                }

                // dont return more than was asked for
                _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
            }else{
                _amountFreed = _amountNeeded;
            }
            return (_amountFreed, _loss);
        }
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
        if (_positionId > 0 && volatilityCheck()) {
            _closePosition(_positionId, false);
            return;
        }
        //we are spending all our cash unless we have debt outstanding
        uint256 _wantBal = want.balanceOf(address(this));
        if(_wantBal < _debtOutstanding && _positionId != 0) {
            // just close the position if the collateralisation ratio is to high
            if (_getCollateralFactor(_positionId) > collateralThreshold) {
                _closePosition(_positionId, false);
            // otherwise do a partial withdrawal
            } else {
                (uint256[] memory repay, uint256 lpAmount) = _calcSingleSidedLiq(_debtOutstanding - _wantBal, true);
                _adjustPosition(_positionId, repay, lpAmount, false, true);
            }
            return;
        }

        // check if the current want amount is large enough to justify opening/adding
        // to an existing position, else do nothing
        if (_wantBal > minWant) {
            if (_positionId == 0) {
                _openPosition(_wantBal);
            } else {
                int256 changeFactor = int256(_getCollateralFactor(_positionId)) - int256(targetCollateralRatio);
                // collateralFactor is real bad close the position
                if (changeFactor > int256(collateralThreshold - targetCollateralRatio)) {
                    _closePosition(_positionId, false);
                    return;
                // collateral factor is bad (5% above target), dont loan any more assets
                } else if (changeFactor > 500) {
                    // we expect to swap out half of the want to eth
                    (uint256[] memory newPosition, ) = _calcSingleSidedLiq((_wantBal) / 2, false);
                    newPosition[0] = _wantBal;
                    _adjustPosition(_positionId, newPosition, 0, false, false);
                } else {
                    // TODO logic to lower the colateral ratio
                    // When adding to the position we will try to stabilize the collateralization ratio, this
                    //  will be possible if we owe more than originally, as we just need to borrow less ETH
                    //  from AHv2. The opposit will currently not work as we want to avoid taking on want
                    //  debt from AHv2.

                    // else if (changeFactor > 0) {
                    //     // See what the % of the position the current pos is
                    //     uint256 assets = _calcEstimatedWant(_positionId);
                    //     uint256[] memory oldPrice = positions[_positionId].openWant;
                    //     uint256 newPercentage = (newPosition[0] * PERCENTAGE_DECIMAL_FACTOR / oldPrice[0])
                    // }
                    (uint256[] memory newPosition, ) = _calcSingleSidedLiq(_wantBal, false);
                    _adjustPosition(_positionId, newPosition, 0, true, false);
                }
            }
        }
    }

    /*
     * @notice tokens that cannot be removed from this strategy (on top of want which is protected by default)
     */
    function _protectedTokens() internal view override returns (address[] memory) {
        address[] memory protected = new address[](1);
        protected[0] = sushi;
        return protected;
    }

    /*
     * @notice tokens that cannot be removed from this strategy (on top of want which is protected by default)
     * @param _callCost Cost of calling tend in want (not used here)
     */
    function tendTrigger(uint256 _callCost) public view override returns (bool) {
        if (activePosition == 0) {
            if (want.balanceOf(address(this)) >= minWant) return true;
        }
        if (volatilityCheck()) return true;
        if (_getCollateralFactor(activePosition) > collateralThreshold) return true;
        return false;
    }

    /*
     * @notice prepare this strategy for migrating to a new
     * @param _newStrategy address of migration target (not used here)
     */
    function _prepareMigration(address _newStrategy) internal override {
        require(activePosition == 0, 'prepareMigration: active position');
        _sellEth(false);
        _sellSushi(false);
    }

    /*
     * @notice Check that an external minAmount is achived when interacting with the AMM
     * @param amount amount to swap
     * @param _minAmount expected minAmount to get out from swap
     */
    function ammCheck(uint256 _amount, uint256 _minAmount) external view override returns (bool) {
        uint256[] memory amounts = _uniPrice(_amount, address(want));
        return (amounts[1] >= _minAmount);
    }  
}
