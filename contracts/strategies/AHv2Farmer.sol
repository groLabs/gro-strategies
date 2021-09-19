// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../BaseStrategy.sol";
import "../common/Constants.sol";
import "hardhat/console.sol";

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

// Uniswap router interface
interface IUni{
    function getAmountsOut(
        uint256 amountIn, 
        address[] calldata path
    ) external view returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

// Uniswap pool interface
interface IUniPool{
    function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast);
    function totalSupply() external view returns (uint256);
}

// homoraBank interface
interface IHomora {
    function execute(uint positionId, address spell, bytes memory data) external payable returns (uint);
    function nextPositionId() external view returns (uint256);
    function borrowBalanceStored(uint positionId, address token) external view returns (uint);
    function getPositionInfo(uint positionId) external view 
        returns (
            address owner,
            address collToken,
            uint collId,
            uint collateralSize
        );
    function getPositionDebts(uint positionId) external view
        returns (address[] memory tokens, uint[] memory debts);
    function getCollateralETHValue(uint positionId) external view returns (uint);
    function getBorrowETHValue(uint positionId) external view returns (uint);
}

interface IWMasterChef {
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function decodeId(uint id) external pure returns (uint pid, uint sushiPerShare);
}

interface IMasterChef {
    function poolInfo(uint pid) external view returns (
        address lpToken,
        uint allocPoint,
        uint lastRewardBlock,
        uint accSushiPerShare
    );
}

// merkle distributor contract interface (uesd by AH to drop alpha tokens)
interface IMerkleClaim {
    function claim(uint256 index, address account, uint256 amount, bytes32[] memory merkleProof) external;
}

contract AHv2Farmer is BaseStrategy, Constants {
    using SafeERC20 for IERC20;

    // LP Pool token
    IUniPool public immutable pool;
    address public constant weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    // Full repay
    uint256 constant REPAY = type(uint256).max;
    address constant alphaToken = address(0xa1faa113cbE53436Df28FF0aEe54275c13B40975);
    
    // Uni or Sushi swap router
    address public immutable uniSwapRouter;
    // comment out if uniSwap spell is used
    address public constant sushi = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public constant homoraBank = address(0xba5eBAf3fc1Fcca67147050Bf80462393814E54B);
    address public constant masterChef = address(0xc2EdaD668740f1aA35E4D8f227fB8E17dcA888Cd);
    address public constant wMasterChef = address(0xA2caEa05fF7B98f10Ad5ddc837F15905f33FEb60);
    address public immutable spell;

    // strategies current position
    uint256 public activePosition;
    // Reserve to keep in contract in case we need to adjust position
    uint256 public reserves;
    // How much change we accept in eth price before closing or adjusting the position
    uint256 public ilThreshold;

    // Min amount of tokens to open/adjust positions or sell
    uint256 public minWant;
    uint256 public constant minEthToSell = 5 * 1E17;
    // comment out if uniSwap spell is used
    uint256 public constant minGovToSell = 10 * 1E18;
    uint256 public constant targetColateralRatio = 7950;

    // TODO add events to functions
    event LogOpenPosition();
    event LogClosePosition();
    event LogAdjustPosition();
    event LogEthToSell();
    event LogGovToSell();

    event NewFarmer(address vault, address spell, address router, address pool, uint256 poolId);
    event NewReservers();
    event NewIlthreshold();
    event NewMinWant();


    struct positionData {
        uint256[] wantClose; // eth value of position when closed [want => eth]
        uint256[] ethClose; // eth amount sold at close [eth => want]
        uint256[] sushiClose; // sushi tokens sold at close [sushi => want]
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
        uint lpTake; // Take out LP token amount (from Homora)
        uint lpWithdraw; // Withdraw LP token amount (back to caller)
        uint aRepay; // Repay tokenA amount
        uint bRepay; // Repay tokenB amount
        uint lpRepay; // Repay LP token amount
        uint aMin; // Desired tokenA amount
        uint bMin; // Desired tokenB amount
    }

    // strategy positions
    mapping(uint256 => positionData) positions;

    // function headers for generating signatures for encoding function calls
    // AHv2 homorabank uses encoded spell function calls in order to cast spells
    string sushiOpen = 'addLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256),uint256)';
    string sushiClose = 'removeLiquidityWMasterChef(address,address,(uint256,uint256,uint256,uint256,uint256,uint256,uint256))';
    // function for selling eth for want (uniswap router)
    string ethForTokens = 'swapExactETHForTokens(uint256,address[],address,uint256)';

    // poolId for masterchef - can be commented out for non sushi spells
    uint256 immutable poolId;

    constructor(address _vault,
                address _spell,
                address router,
                address _pool,
                uint256 _poolId
    ) BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        want.safeApprove(homoraBank, type(uint256).max);
        spell = _spell;
        uniSwapRouter = router;
        pool = IUniPool(_pool);
        poolId = _poolId;

        uint256 _minWant = 1000 * (10 ** VaultAPI(_vault).decimals());
        minWant = _minWant; // dont open or adjust a position unless more than 1000 want
        reserves = _minWant; // keep a 1000 want in reserve in case we need to adjust position
        ilThreshold = 500; // 5%
        emit NewFarmer(_vault, _spell, router, _pool, _poolId);
    }

    function name() external pure override returns (string memory) {
        return "Ahv2 strategy";
    }
        
    // Strategy will recieve eth from closing/adjusting positions, do nothing with the eth here
    receive() external payable {
    }

    /*
     * @notice Estimate amount of sushi tokens that will be claimed if position is closed
     */
    function pendingSushi() public view returns (uint256) {
        uint256 _positionId = activePosition;
        require(_positionId != 0);
        console.log('pendingSushi');
        IWMasterChef wChef = IWMasterChef(wMasterChef);
        uint256 _collId = positions[activePosition].collId;
        uint256 amount = wChef.balanceOf(homoraBank, _collId);
        console.log('_collId %s', _collId);
        console.log('amount %s', amount);
        (uint256 pid, uint256 stSushiPerShare) = wChef.decodeId(_collId);
        console.log('pid %s stSushiPerShare %s', pid, stSushiPerShare);
        (, , , uint256 enSushiPerShare) = IMasterChef(masterChef).poolInfo(pid);
        console.log('enSushiPerShare %s', enSushiPerShare);
        uint stSushi = (stSushiPerShare * amount - 1) / 1e12;
        uint enSushi = enSushiPerShare * amount / 1e12;
        console.log('stSushi %s', stSushi);
        console.log('enSushi %s', enSushi);
        if (enSushi > stSushi) {
            return enSushi - stSushi;
        }
        return 0;
    }

    function valueOfSushi() internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = sushi;
        path[1] = address(want);

        uint256 estimatedSushi = pendingSushi();
        if (estimatedSushi > 0 ) {
            uint256[] memory sushiWantValue = uniPrice(estimatedSushi, sushi);
            return sushiWantValue[1];
        } else {
            return 0;
        }
    }

    /*
     * @notice Claim pending alpha rewards and transfer it to the rewards contract
     * @param claimsContract alpha merkle distributer contract
     * @param index position index
     * @param amount position amount
     * @param merkleProof position merkle proof
     */
    function claimAlpha(
        address claimsContract,
        uint256 index,
        uint256 amount,
        bytes32[] memory merkleProof) external 
    {
        IMerkleClaim(claimsContract).claim(index, msg.sender, amount, merkleProof);
        uint256 alphaBalance = IERC20(alphaToken).balanceOf(address(this));
        if (alphaBalance > 0) {
            IERC20(alphaToken).safeTransfer(rewards, alphaBalance);
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
     *          the strategy will add the available funds to the strategy. This reset the current position
     *          impermanent loss, and reset the positions price in relation to calculate the ilThreshold
     * @param amounts amount to adjust position by [want, eth]
     * @param collateral collateral to remove (0 if adding to position)
     * @param withdraw remove or add to position
     */
    function _adjustPosition(uint256 _positionId, uint256[] memory amounts, uint256 collateral, bool withdraw) internal {
        console.log('_adjusting %s : %s %s', _positionId, amounts[0], amounts[1]);
        console.log('withdraw');
        console.logBool(withdraw);
        if (withdraw) {
            int256[] memory minAmounts = new int256[](2);
            minAmounts[1] = int256(amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR);
            minAmounts[0] = int256(0);

            // here for print statment, remove
            uint256 _want = want.balanceOf(address(this));
            uint256 _eth = address(this).balance;
            RepayAmounts memory amt = formatClose(minAmounts, collateral, amounts[1]);
            console.log('col: %s, repay %s', amt.lpTake, amt.bRepay);
            console.log('amin %s, bmin %s', amt.aMin, amt.bMin);
            IHomora(homoraBank).execute(
                    _positionId,
                    spell,
                    abi.encodeWithSignature(sushiClose, address(want), weth, amt)
            );
            console.log('Pre want %s eth %s', want.balanceOf(address(this)) - _want, address(this).balance - _eth);
        } else {
            Amounts memory amt = formatOpen(amounts);
            console.log('amta %s. a min %s', amt.aUser, amt.aMin);
            console.log('amtb %s. b min %s', amt.bBorrow, amt.bMin);
            IHomora(homoraBank).execute(
                    _positionId,
                    spell,
                    abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
            );
        }

        adjustPositionData(_positionId, amounts, withdraw);
    }

    /*
     * @notice Open a new AHv2 position with market neutral leverage
     * @param amount amount of want to provide to prosition
     */
    function openPosition(uint256 amount) internal onlyAuthorized {
        uint256[] memory amounts = uniPrice(amount, address(want));
        Amounts memory amt = formatOpen(amounts);
        console.log('amta %s. a min %s', amt.aUser, amt.aMin);
        console.log('amtb %s. b min %s', amt.bBorrow, amt.bMin);
        console.log(amount);
        console.logBytes(abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId));
        IHomora(homoraBank).execute(
                0,
                spell,
                abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
        );
        loadPositionData(IHomora(homoraBank).nextPositionId() - 1, amounts);
    }
    
    function adjustPositionData(uint256 _positionId, uint256[] memory amounts, bool withdraw) internal {
        positionData storage pos = positions[_positionId];
        uint256[] memory _openPrice = pos.wantOpen;
        if (!withdraw) {
            _openPrice[0] += amounts[0];
            _openPrice[1] += amounts[1];
        }
        (, , , uint256 collateralSize) = IHomora(homoraBank).getPositionInfo(_positionId);
        (, uint[] memory debts) = IHomora(homoraBank).getPositionDebts(_positionId);
        pos.collateral = collateralSize;
        pos.debt = debts;
    }

    /*
     * @notice Create or update the position data for indicated position
     * @param positionId id of position
     * @param openPrice eth price of want of position [want => eth]
     */
    function loadPositionData(uint256 _positionId, uint256[] memory openPrice) internal {
        positionData storage pos = positions[_positionId];
        if (activePosition == 0) {
            activePosition = _positionId;
        }
        
        (, address collToken, uint256 collId, uint256 collateralSize) = IHomora(homoraBank).getPositionInfo(_positionId);
        (address[] memory tokens, uint[] memory debts) = IHomora(homoraBank).getPositionDebts(_positionId);

        pos.active = true;
        pos.debtTokens = tokens;
        pos.collToken = collToken;
        pos.wantOpen = openPrice;
        pos.collId = collId;
        pos.collateral = collateralSize;
        pos.debt = debts;
    }

    /*
     * @notice Force close the AHv2 position, here to be used if something goes horribly wrong
     */
    function panicClose(uint256 _positionId) external onlyAuthorized {
        uint256 collateral = positions[_positionId].collateral;
        // Get back what we can get back
        RepayAmounts memory amt;
        amt.lpTake = collateral;
        amt.bRepay = REPAY;
        uint256 wantBal = want.balanceOf(address(this));
        IHomora(homoraBank).execute(
                _positionId,
                spell,
                abi.encodeWithSignature(sushiClose, address(want), weth, amt)
        );
        wantBal = want.balanceOf(address(this)) - wantBal;
        positionData storage pos = positions[_positionId];
        pos.active = false;
        pos.totalClose = wantBal;
        pos.wantClose = uniPrice(pos.wantOpen[0], address(want));
        activePosition = 0;
    }

    /*
     * @notice Close and active AHv2 position 
     */
    function closePosition(uint256 _positionId) internal {
        // active position data
        positionData storage pd = positions[_positionId];
        uint256 collateral = pd.collateral;
        uint256[] memory debts = pd.debt;
        // Calculate amount we expect to get out by closing the position
        // Note, expected will be [eth, want], as debts always will be [eth] and solidity doesnt support 
        // sensible operations like [::-1] or zip...
        int256[] memory expected = _calcAvailable(collateral, debts);
        RepayAmounts memory amt = formatClose(expected, collateral, 0);
        console.logBytes(abi.encodeWithSignature(sushiClose, address(want), weth, amt));
        console.log('collateral %s', collateral);
        console.log('col: %s, repay %s', amt.lpTake, amt.bRepay);
        console.log('amin %s, bmin %s', amt.aMin, amt.bMin);
        uint256 wantBal = want.balanceOf(address(this));
        IHomora(homoraBank).execute(
                _positionId,
                spell,
                abi.encodeWithSignature(sushiClose, address(want), weth, amt)
        );
        // Try to sell excess eth
        uint256[] memory _ethClose = sellEth();
        // sell excess sushi - comment out if uniSwap spell is used
        uint256[] memory _sushiClose = sellSushi();
        // total amount of want retrieved from position
        wantBal = want.balanceOf(address(this)) - wantBal;
        positionData storage pos = positions[_positionId];
        pos.active = false;
        pos.ethClose = _ethClose;
        // comment out if uniSwap spell is used
        pos.sushiClose = _sushiClose;
        pos.totalClose = wantBal;
        pos.wantClose = uniPrice(pos.wantOpen[0], address(want));
        activePosition = 0;
    }

    /*
     * @notice sell the contracts eth for want if there enough to justify the sell
     */
    function sellEth() internal returns (uint256[] memory) {
        uint256 balance = address(this).balance;

        // check if we have enough eth to sell
        if (balance >= minEthToSell) {
            address[] memory path = new address[](2);
            path[0] = weth;
            path[1] = address(want);

            uint256[] memory amounts = uniPrice(balance, weth);
            // Use a call to the uniswap router contract to swap exact eth for want
            // note, minwant could be set to 0 here as it doesnt matter, this call
            // cannot prevent any frontrunning and the transaction should be executed
            // using a private host.
            (bool success, ) = uniSwapRouter.call{value: balance}(
                abi.encodeWithSignature(ethForTokens, minWant, path, address(this), block.timestamp)
            );
            require(success);
            return amounts;
        } 
        return new uint256[](2);
    }

    /*
     * @notice sell the contracts sushi for want if there enough to justify the sell - can remove this method if uni swap spell
     */
    function sellSushi() internal returns (uint256[] memory) {
        uint256 balance = IERC20(sushi).balanceOf(address(this));
        if (balance >= minGovToSell) {
            address[] memory path = new address[](2);
            path[0] = sushi;
            path[1] = address(want);

            uint256[] memory amounts = uniPrice(balance, sushi);
            IUni(uniSwapRouter).swapExactTokensForTokens(amounts[0], amounts[1], path, address(this), block.timestamp);
            return amounts;
        }
        return new uint256[](2);
    }

    /*
     * @notice get active position data
     */
    function getPosition() external view returns (
        address owner,
        address collToken,
        uint collId,
        uint collateralSize
    ) {
        return IHomora(homoraBank).getPositionInfo(activePosition);
    }

    /*
     * @notice get active position debt
     */
    function getDebt() external view returns (
        address[] memory tokens,
        uint[] memory debts
    ) {
        return IHomora(homoraBank).getPositionDebts(activePosition);
    }

    /*
     * @notice set minimum want required to adjust position 
     * @param _minWant minimum amount of want
     */
    function setMinWant(uint256 _minWant) external onlyAuthorized {
        minWant = _minWant;
    }

    /*
     * @notice format the open position input struct
     * @param amounts amounts for position
     */
    function formatOpen(uint256[] memory amounts) internal pure returns (Amounts memory amt) {
        amt.aUser = amounts[0];
        amt.bBorrow = amounts[1];
        // apply 1 BP slippage to the position
        amt.aMin = amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 50) / PERCENTAGE_DECIMAL_FACTOR;
        amt.bMin = amounts[1] * (PERCENTAGE_DECIMAL_FACTOR - 50) / PERCENTAGE_DECIMAL_FACTOR;
    }

    /*
     * @notice format the close position input struct
     * @param expect expected return amounts
     * @param collateral collateral to remove from position
     * @param repay amount to repay - default to max value if closing position
     */
    function formatClose(int256[] memory expected, uint256 collateral, uint256 repay) internal pure returns (RepayAmounts memory amt) {
        repay = (repay == 0) ? REPAY : repay;
        amt.lpTake = collateral;
        amt.bRepay = repay;
        amt.aMin = uint256(expected[1]);
        amt.bMin = uint256(expected[0]);
    }

    /*
     * @notice get start of swap path based in index
     * @param i 0 - want, 1 - weth
     */
    function getPath(uint256 i) private view returns (address) {
        if (i == 0) {
            return address(want);
        } else {
            return weth;
        }
    }
    
    /*
     * @notice calculate want and eth value of lp position
     *      value of lp is defined by (in uniswap routerv2):
     *          lp = Math.min(input0 * poolBalance / reserve0, input1 * poolBalance / reserve1)
     *      which in turn implies:
     *          input0 = reserve0 * lp / poolBalance
     *          input1 = reserve1 * lp / poolBalance
     * @param collateral lp amount
     * @dev Note that we swap the order of want and eth in the return array, this is because
     *      the debt position always will be in eth, and to save gas we dont add a 0 value for the
     *      want debt. So when doing repay calculations we need to remove the debt from the eth amount,
     *      which becomes simpler if the eth position comes first.
     */
    function calcLpPosition(uint256 collateral) internal view returns (uint256[] memory) {
        (uint112 reserve0, uint112 reserve1, ) = IUniPool(pool).getReserves();
        uint256 poolBalance = IUniPool(pool).totalSupply();
        uint256 share = collateral * PERCENTAGE_DECIMAL_FACTOR / poolBalance;
        uint256[] memory lpPosition = new uint256[](2);

        lpPosition[1] = uint256(reserve0) * share / PERCENTAGE_DECIMAL_FACTOR;
        lpPosition[0] = uint256(reserve1) * share / PERCENTAGE_DECIMAL_FACTOR;
        return lpPosition;
    }

    /*
     * @notice calc want value of eth
     * @param amount amount of eth
     */
    function calcWant(uint256 eth) private view returns (uint256) {
        uint256[] memory swap = uniPrice(eth, weth);
        return swap[1];
    }
    /*
     * @notice get swap price in uniswap pool
     * @param amount amount of token to swap
     * @param start token to swap out
     */
    function uniPrice(uint256 amount, address start) internal view returns (uint256[] memory) {
        address[] memory path= new address[](2);
        if (start == weth) {
            path[0] = start;
            path[1] = address(want);
        } else {
            path[0] = start; 
            path[1] = weth; 
        }
        console.log('----uniPrice');
        console.log('amount %s', amount);
        uint256[] memory amounts = IUni(uniSwapRouter).getAmountsOut(amount, path);

        return amounts;
    }

    /*
     * @notic Get the estimated total assets of this strategy in want.
     *      This method is only used to pull out debt if debt ratio has changed.
     * @return Total assets in want this strategy has invested into underlying protocol
     */
    function estimatedTotalAssets() public view override returns (uint256) {
        // get the value of the current position supplied by this strategy (total - borrowed)
        uint256 _valueOfDeposit = _calcEstimatedWant(activePosition);
        uint256 _valueOfSushi = valueOfSushi();
        uint256[] memory _valueOfEth = uniPrice(address(this).balance, weth);
        
        return want.balanceOf(address(this)) + _valueOfDeposit + _valueOfSushi + _valueOfEth[1];
    }

    /*
     * @notice expected profit/loss of the strategy
     */
    function expectedReturn() external view returns (int256) {
        uint256 estimateAssets = estimatedTotalAssets();

        uint256 debt = vault.strategies(address(this)).totalDebt;
        if (debt > estimateAssets) {
            return 0;
        } else {
            return int256(estimateAssets) - int256(debt);
        }
    }

    /*
     * @notice get collateral and borrowed eth value of position
     */
    function getCollateralFactor() private view returns (uint256) {
        uint256 deposit = IHomora(homoraBank).getCollateralETHValue(activePosition);
        uint256 borrow =  IHomora(homoraBank).getBorrowETHValue(activePosition);
        return borrow * PERCENTAGE_DECIMAL_FACTOR / deposit;
    }

    /*
     * @notice set reserve of want to be kept in contract
     * @param newReserves new reserve amount
     */
    function setReserves(uint256 newReserves) external {
        reserves = newReserves;
    }

    /*
     * @notice set il threshold - this indicates when a position should be closed or adjusted
     * @param newThreshold new il threshold
     */
    function setIlThreshold(uint256 newThreshold) external {
        require(newThreshold <= 10000, 'setIlThreshold: !newThreshold');
        ilThreshold = newThreshold;
    }

    /*
     * @notice Calculate strategies current loss, profit and amount if can repay
     * @param _debtOutstanding amount of debt remaining to be repaid
     */
    function prepareReturn(uint256 _debtOutstanding)
        internal
        override
        returns (
            uint256 _profit,
            uint256 _loss,
            uint256 _debtPayment
        )
    {
        console.log('-----prepareReturn');
        console.log('activePosition %s', activePosition);
        uint256 _positionId = activePosition;
        if (_positionId == 0) {
            //no active position
            uint256 _wantBalance = want.balanceOf(address(this));
            _debtPayment = Math.min(_wantBalance, _debtOutstanding); 
            return (_profit, _loss, _debtPayment);
        }

        // try to sell sushi and eth if possible
        sellSushi();
        sellEth();
        uint256 wantBalance = want.balanceOf(address(this));

        // want value of deposit
        uint256 balance = _calcEstimatedWant(_positionId) + wantBalance;

        uint256 debt = vault.strategies(address(this)).totalDebt;

        // Balance - Total Debt is profit
        console.log('balance %s debt %s', balance, debt);
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
        uint256[] memory currentPrice = uniPrice(openPrice[0], address(want));
        console.log('open %s %s', openPrice[0], openPrice[1]);
        console.log('currentPrice %s %s', currentPrice[0], currentPrice[1]);
        uint256 difference;
        if (openPrice[1] < currentPrice[1]) {
            difference = (currentPrice[1] * PERCENTAGE_DECIMAL_FACTOR / openPrice[1]);
        } else {
            difference = (openPrice[1] * PERCENTAGE_DECIMAL_FACTOR / currentPrice[1]);
        }
        console.log('difference %s, ilThreshold %s', difference, ilThreshold);
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
     * @param collateral lp value of position
     * @param debts debts to repay (should always be eth)
     */
    function _calcAvailable(uint256 collateral, uint256[] memory debts) private view returns (int256[] memory) {
        // get underlying value of lp postion [eth, want]
        uint256[] memory lpPosition = calcLpPosition(collateral);
        int256[] memory expected = new int256[](2);
        console.log('-----_calcAvailable');
        console.log('lpPosition want %s eth %s', lpPosition[1], lpPosition[0]);
        console.log('debts eth %s', debts[0]);

        for (uint256 i; i < 2; i++) {
            // standrad AH exit applies 1% slippage to close position
            uint256 positionWithSlippage = lpPosition[i] * (PERCENTAGE_DECIMAL_FACTOR - 100) / PERCENTAGE_DECIMAL_FACTOR;
            if (i < debts.length) {
                // repay eth debt
                expected[i] = int256(positionWithSlippage) - int256(debts[i]);
            } else {
                expected[i] = int256(positionWithSlippage);
            }
        }

        console.log('expected want');
        console.logInt(expected[1]);
        console.log('expected eth');
        console.logInt(expected[0]);
        for (uint256 i; i < 2 ; i++) {
            // if the eth return is negative, we need to reduce the the expected want by the amount
            // that will be used to repay the whole eth loan
            if (expected[i] < 0) {
                uint256[] memory change = uniPrice(uint256(expected[i] * -1), getPath(1 - i));
                console.log('change want %s eth %s', change[1], change[0]);
                expected[1 - i] -= int256(change[1]);
                expected[i] = 0;
                break;
            } 
        }
        console.log('repay');
        console.log('expected want');
        console.logInt(expected[1]);
        console.log('expected eth');
        console.logInt(expected[0]);
        return expected;
    }

    function _calcEstimatedWant(uint256 _positionId) private view returns (uint256) {
        positionData storage pos = positions[_positionId];
        // get underlying value of lp postion [eth, want]
        uint256[] memory lpPosition = calcLpPosition(pos.collateral);
        uint256[] memory debt = pos.debt;
        int256 ethPosition = int256(lpPosition[0]) - int256(debt[0]);
        return (ethPosition > 0) ? lpPosition[1] + calcWant(uint256(ethPosition)) 
            : lpPosition[1] - calcWant(uint256(ethPosition * -1));
    }

    /*
     * @notice calculate the lp value of the the want/eth amount:
     *      formula is used by unisap router:
     *          lp = Math.min(input0 * poolBalance / reserve0, input1 * poolBalance / reserve1)
     * @param input liquidity amount [want, eth] 
     */
    function calcLpAmount(uint256[] memory input) internal view returns (uint256) {
        (uint112 reserve0, uint112 reserve1, ) = IUniPool(pool).getReserves();
        uint256 poolBalance = IUniPool(pool).totalSupply();

        uint256 liquidity = Math.min(input[0] * poolBalance / reserve0, input[1] * poolBalance / reserve1);
        return liquidity;
    }

    /*
     * @notice Remove part of the current position in order to repay debt or accomodate a withdrawal
     * @param amount amount of want we want to withdraw
     * @dev This is a gas costly operation, should not be atempted unless the amount being withdrawn warrants it,
     *      this operation also resets the position to market neutral
     */
    function _withdrawSome(uint256 _positionId, uint256 _amount) internal {
        console.log('withdraw some %s', _amount);
        uint256[] memory repay = uniPrice(_amount, address(want));
        uint256 lpAmount = calcLpAmount(repay);
        _adjustPosition(_positionId, repay, lpAmount, true);
    }

    /*
     * @notice partially removes or closes the current AH v2 position in order to repay a requested amount
     * @param _amountNeeded amount needed to be withdrawn from strategy
     */
    function liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _amountFreed, uint256 _loss)
    {
        // want in contract + want value of position based of eth value of position (total - borrowed)
        uint256 _positionId = activePosition;
        uint256 _balance = want.balanceOf(address(this));
        uint256 assets = _calcEstimatedWant(_positionId);

        uint256 debtOutstanding = vault.debtOutstanding();

        // cannot repay the entire debt
        if(debtOutstanding > assets + _balance) {
            // Sell all of our other assets if we hold any
            sellEth();
            sellSushi();
            _balance = want.balanceOf(address(this));
            // if we still cant repay we report a loss
            if(debtOutstanding > assets + _balance) {
                _loss = debtOutstanding - (assets + _balance);
            }
        }

        console.log('liquidatePosition assets %s amountNeeded %s', assets, _amountNeeded);
        // if the asset value of our position is less than what we need to withdraw, close the position
        if (assets < _amountNeeded) {
            if (activePosition != 0) {
                closePosition(_positionId);
            }
            _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
        } else {
            // do we have enough assets in strategy to repay?
            if (_balance < _amountNeeded) {
                uint256 remainder;
                // because pulling out assets from AHv2 tends to give us less assets than
                // we want specify, so lets see if we can pull out a bit in excess to be
                // able to pay back the full amount
                if(assets > _amountNeeded - _balance / 2) {
                    remainder = _amountNeeded - _balance / 2;
                } else {
                    // but if not possible just pull the original amount
                    remainder = _amountNeeded - _balance;
                }

                // if we want to remove 90% or more of the position, just close it
                if (remainder * PERCENTAGE_DECIMAL_FACTOR / assets >= 9000) {
                    closePosition(_positionId);
                } else {
                    console.log('withdraw some _balance %s remainder %s', _balance, remainder);
                    _withdrawSome(_positionId, remainder);
                }

                // dont return more than was asked for
                _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
            }else{
                _amountFreed = _amountNeeded;
            }
        }
    }

    /*
     * @notice adjust current position, repaying any debt
     * @param _debtOutstanding amount of outstanding debt the strategy holds
     */
    function adjustPosition(uint256 _debtOutstanding) internal override {
        //emergency exit is dealt with in prepareReturn
        console.log('------------adjustPosition');
        if (emergencyExit) {
            return;
        }

        uint256 _positionId = activePosition;
        console.log('activePosition %s', activePosition);
        console.log('volatilityCheck %s', volatilityCheck());
        if (_positionId > 0 && volatilityCheck()) {
            closePosition(_positionId);
            return;
        }
        //we are spending all our cash unless we have debt outstanding
        uint256 _wantBal = want.balanceOf(address(this));
        console.log('_wantBal %s, _debtOutstanding %s', _wantBal, _debtOutstanding);
        if(_wantBal < _debtOutstanding && _positionId != 0) {
            if (getCollateralFactor() > targetColateralRatio){
                closePosition(_positionId);
            } else {
                _withdrawSome(_positionId, _debtOutstanding - _wantBal);
            }
            return;
        }
        console.log('_wantBal %s minWant %s reserves %s', _wantBal, minWant, reserves);
        console.log('activePosition %s', activePosition);
        // check if the current want amount is large enough to justify opening/adding
        // to an existing position, else do nothing
        if (_wantBal > minWant + reserves) {
            if (_positionId == 0) {
                openPosition(_wantBal - reserves);
            } else {
                uint256[] memory newPosition = uniPrice(_wantBal - reserves, address(want));
                _adjustPosition(_positionId, newPosition, 0, false);
            }
        }
    }

    /*
     * @notice tokens that cannot be removed from this strategy (on top of want which is protected by default)
     */
    function protectedTokens() internal view override returns (address[] memory) {
        // sushi
        // lp
    }

    function tendTrigger(uint256 callCost) public view override returns (bool) {}
    /*
     * @notice prepare this strategy for migrating to a new
     * @param _newStrategy address of migration target
     */
    function prepareMigration(address _newStrategy) internal override {
        require(activePosition == 0, 'prepareMigration: active position');
        sellEth();
        uint256 ethBalance = address(this).balance;
        if (ethBalance > 0) {
            (bool success, ) = _newStrategy.call{value: ethBalance}("");
            require(success);
        }
        sellSushi();
        uint256 sushiBalance = address(this).balance;
        if (sushiBalance > 0) {
            IERC20(sushi).safeTransfer(_newStrategy, sushiBalance);
        }
    }
}
