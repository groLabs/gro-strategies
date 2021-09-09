// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IVaultMK2.sol";
import "../BaseStrategy.sol";
import "../common/Constants.sol";
import "../common/Whitelist.sol";

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

interface IUniPool{
    function getReserves() external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast);
    function totalSupply() external view returns (uint256);
}

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

contract AHv2Farmer is BaseStrategy, Constants {
    using SafeERC20 for IERC20;

    // LP Pool token
    IERC20 public immutable lpToken;
    IUniPool public immutable pool;
    address public constant weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    uint256 constant REPAY = 115792089237316195423570985008687907853269984665640564039457584007913129639935;
    
    // Uni or Sushi swap router
    address public immutable uniswapRouter;
	address public immutable spell;
    address public constant homoraBank = address(0xba5eBAf3fc1Fcca67147050Bf80462393814E54B);

    uint256 activePosition;
    uint256 minWant;
	uint256 reserves;
	uint256 ilThreshold;
    uint256 minGovtoSell;

	event newFarmer(address vault, address spell, address router, address lpt, uint256 poolId);

    struct positionData {
        uint256[] close;
        uint256[] open;
        address collToken;
        uint256 collId;
        uint256 collateral;
        address[] debtTokens;
        uint256[] debt;
        bool active;
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

    mapping(uint256 => positionData) positions;

    // Sushi variables
    string sushiOpen = 'addLiquidityWMasterChef(address,address,tuple,uint256)';
    string sushiClose = 'removeLiquidityWMasterChef(address,address,tuple)';
    uint256 immutable poolId;

    constructor(address _vault, address _spell, address router, address lpt, address _pool, uint256 _poolId) public BaseStrategy(_vault) {
        profitFactor = 1000;
        debtThreshold = 1_000_000 * 1e18;
        want.safeApprove(homoraBank, type(uint256).max);
		spell = _spell;
		uniswapRouter = router;
		lpToken = IERC20(lpt);
        pool = IUniPool(_pool);
        poolId = _poolId;
		emit newFarmer(_vault, _spell, router, lpt, _poolId);
    }

    function name() external view override returns (string memory) {
        return "Ahv2 strategy";
    }

	function _adjustPosition(uint256[] memory amounts) internal {
        Amounts memory amt = formatOpen(amounts);
        IHomora(homoraBank).execute(
                activePosition,
                spell,
                abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
        );
        loadPositionData(IHomora(homoraBank).nextPositionId() - 1, amounts);
    }

    function openPosition(uint256 amount) internal onlyAuthorized {
        uint256[] memory amounts = uniPrice(amount, address(want));
        Amounts memory amt = formatOpen(amounts);
        IHomora(homoraBank).execute(
                0,
                spell,
                abi.encodeWithSignature(sushiOpen, address(want), weth, amt, poolId)
        );
        loadPositionData(IHomora(homoraBank).nextPositionId() - 1, amounts);
    }
    
    function loadPositionData(uint256 positionId, uint256[] memory openPrice) internal {
        positionData storage pos = positions[positionId];
        
        (address owner, address collToken, uint256 collId, uint256 collateralSize) = IHomora(homoraBank).getPositionInfo(positionId);
        (address[] memory tokens, uint[] memory debts) = IHomora(homoraBank).getPositionDebts(positionId);

        pos.open = openPrice;
        pos.collToken = collToken;
        pos.collId = collId;
        pos.collateral = collateralSize;
        pos.debtTokens = tokens;
        pos.debt = debts;
        pos.active = true;
    }

	function panicClose() external onlyAuthorized {
		closePosition();
	}

    function closePosition() internal {
        RepayAmounts memory amt = formatClose();
        IHomora(homoraBank).execute(
                0,
                spell,
                abi.encodeWithSignature(sushiClose, address(want), weth, amt)
        );
        positionData storage pos = positions[activePosition];
        pos.active = false;
        pos.close = uniPrice(pos.open[0], address(want));
    }

    function getPosition() external view returns (
        address owner,
        address collToken,
        uint collId,
        uint collateralSize
    ) {
		return IHomora(homoraBank).getPositionInfo(activePosition);
    }

    function getDebt() external view returns (
        address[] memory tokens,
        uint[] memory debts
    ) {
		return IHomora(homoraBank).getPositionDebts(activePosition);
    }

    function setMinGovToSell(uint256 _min) external onlyAuthorized {
                minGovtoSell = _min;
    }

    function setMinWant(uint256 _minWant) external onlyAuthorized {
                minWant = _minWant;
    }

    function formatOpen(uint256[] memory amounts) internal view returns (Amounts memory amt) {
        amt.aUser = amounts[0];
        amt.bBorrow = amounts[1];
        amt.aMin = amounts[0] * (PERCENTAGE_DECIMAL_FACTOR - 1) / PERCENTAGE_DECIMAL_FACTOR;
        amt.bMin = amounts[1] * (PERCENTAGE_DECIMAL_FACTOR - 1) / PERCENTAGE_DECIMAL_FACTOR;
    }

    function formatClose() internal view returns (RepayAmounts memory amt) {
        positionData storage pd = positions[activePosition];
        uint256 collateral = pd.collateral;
        uint256[] memory debts = pd.debt;
        int256[] memory expected = _calcWantAvailable(collateral, debts); 

        amt.lpTake = collateral;
        amt.bRepay = REPAY;
        amt.aMin = uint256(expected[1]);
        amt.bMin = uint256(expected[0]);
    }

    function getPath(uint256 i) private view returns (address) {
        if (i == 0) {
            return address(want);
        } else {
            return weth;
        }
    }
    
    function calcLpPosition(uint256 collateral) internal view returns (uint256[] memory) {
        (uint112 reserve0, uint112 reserve1, ) = IUniPool(pool).getReserves();
        uint256 poolBalance = IERC20(lpToken).totalSupply();
        uint256 share = collateral * PERCENTAGE_DECIMAL_FACTOR / poolBalance;
        uint256[] memory lpPosition = new uint256[](2);

        lpPosition[1] = uint256(reserve0) * share;
        lpPosition[0] = uint256(reserve1) * share;
        return lpPosition;
    }

    function uniPrice(uint256 amount, address start) internal view returns (uint256[] memory amounts) {
        address[] memory path;
        if(start == weth){
            path = new address[](2);
            path[0] = start;
            path[1] = address(want);
        }else{
            path = new address[](2);
            path[0] = start; 
            path[1] = weth; 
        }
 
        uint256[] memory amounts = IUni(uniswapRouter).getAmountsOut(amount, path);

        return amounts;
    }

    /// @notice Get the total assets of this strategy.
    ///     This method is only used to pull out debt if debt ratio has changed.
    /// @return Total assets in want this strategy has invested into underlying vault
    function estimatedTotalAssets() public view override returns (uint256) {

		uint256 valueOfDeposit = valueOfDeposit();
        // uint256 currentSushi = ... calculate amount of sushi
        return want.balanceOf(address(this)) + valueOfDeposit; // + currentSushi
    }

    function expectedReturn() external view returns (uint256) {
        uint256 estimateAssets = estimatedTotalAssets();

        uint256 debt = vault.strategies(address(this)).totalDebt;
        if (debt > estimateAssets) {
            return 0;
        } else {
            return estimateAssets - debt;
        }
    }

	function getCurrentPosition() private view returns (uint256 deposit, uint256 borrow) {
        uint256 deposit = IHomora(homoraBank).getCollateralETHValue(activePosition);
		uint256 borrow =  IHomora(homoraBank).getBorrowETHValue(activePosition);
	}

	function setReserves(uint256 newReserves) external {
        require(newReserves <= 1000, 'setReserves: !newReserves');
        reserves = newReserves;
	}

	function setIlThreshold(uint256 newThreshold) external {
        require(newThreshold <= 1000, 'setIlThreshold: !newThreshold');
        ilThreshold = newThreshold;
	}

    function valueOfDeposit() private view returns (uint256) {
        (uint256 deposits, uint256 borrows) = getCurrentPosition();
        uint256[] memory value = uniPrice(deposits - borrows, weth);
        return value[1];
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
        if (activePosition == 0) {
            uint256 wantBalance = want.balanceOf(address(this));
            //no active position
            _debtPayment = Math.min(wantBalance, _debtOutstanding); 
            return (_profit, _loss, _debtPayment);
        }

		// get sushi amount ??
		// sell sushi amount ??

        uint256 wantBalance = want.balanceOf(address(this));

		// want value of deposit
		uint256 investedBalance = valueOfDeposit();
        uint256 balance = investedBalance + wantBalance;

        uint256 debt = vault.strategies(address(this)).totalDebt;

        //Balance - Total Debt is profit
        if (balance > debt) {
            _profit = balance - debt;

            if (wantBalance < _profit) {
                //all reserve is profit                
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
    
    function volatilityCheck() public view returns(bool) {
        if (activePosition == 0) {
            return false;
        }
        uint256[] memory openPrice = positions[activePosition].open;
        uint256[] memory currentPrice = uniPrice(openPrice[0], address(want));
        uint256 difference = (openPrice[1] * PERCENTAGE_DECIMAL_FACTOR / currentPrice[1]);
        if (difference >= ilThreshold) return true;
        return false;

    }

    function _calcDesiredPosition(uint256 _amount, bool add) private returns (uint256[] memory) {
        positionData storage pd = positions[activePosition];
        uint256 collateral = pd.collateral;

        uint256[] memory lpPosition = calcLpPosition(collateral);

        if (add) {
            uint256[] memory newPosition = uniPrice(_amount - reserves, address(want));
            for (uint256 i; i < 2; i ++) {
                newPosition[i] += lpPosition[1-i];
            }
            return newPosition;
        } else {
            if (_amount < lpPosition[1]) {
                uint256[] memory repay = uniPrice(_amount, address(want));
                lpPosition[0] -= repay[1];
                lpPosition[1] -= _amount;
                return lpPosition;
            }
        }
    }

    function _calcWantAvailable(uint256 collateral, uint256[] memory debts) private view returns (int256[] memory) {
        uint256[] memory lpPosition = calcLpPosition(collateral);
        int256[] memory expected = new int256[](2);

        uint256 amount;
        for (uint256 i; i < 2; i++) {
            uint256 positionWithSlippage = lpPosition[i] * (PERCENTAGE_DECIMAL_FACTOR - 10) / PERCENTAGE_DECIMAL_FACTOR;
            if (i < debts.length) {
                expected[i] = int256(positionWithSlippage) - int256(debts[i]);
            } else {
                expected[i] = int256(positionWithSlippage);
            }
        }

        for (uint256 i; i < 2 ; i++) {
            if (expected[i] < 0) {
                uint256[] memory change = uniPrice(uint256(expected[i] * -1), getPath(1 - i));
                expected[1 - i] -= int256(change[1]);
                expected[i] = 0;
            } 
        }
        return expected;
    }

    /// @param _amount Expected amount to withdraw
    function _withdrawSome(uint256 _amount) internal returns (uint256) {
        uint256[] memory newPosition = _calcDesiredPosition(_amount, false);
        if (newPosition[0] > 0) {
            _adjustPosition(newPosition);
        }
    }

    /// @param _amountNeeded Expected amount to withdraw
    function liquidatePosition(uint256 _amountNeeded)
        internal
        override
        returns (uint256 _amountFreed, uint256 _loss)
    {
        uint256 _balance = want.balanceOf(address(this));
        uint256 assets = valueOfDeposit(); 

        uint256 debtOutstanding = vault.debtOutstanding();

        if(debtOutstanding > assets){
            _loss = debtOutstanding - assets;
        }

        if (assets < _amountNeeded) {

			if (activePosition != 0) {
				closePosition();
            }

            _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
           
        } else {
            if (_balance < _amountNeeded) {
                _withdrawSome(_amountNeeded - _balance);

                //overflow error if we return more than asked for
                _amountFreed = Math.min(_amountNeeded, want.balanceOf(address(this)));
            }else{
                _amountFreed = _amountNeeded;
            }
        }
    }

    /// @param _debtOutstanding Should always be 0 at this point
    function adjustPosition(uint256 _debtOutstanding) internal override {
		//emergency exit is dealt with in prepareReturn
        if (emergencyExit) {
            return;
        }

        uint256 _activePosition = activePosition;
        if (_activePosition > 0 && volatilityCheck()) {
            closePosition();
            return;
        }

        //we are spending all our cash unless we have debt outstanding
        uint256 _wantBal = want.balanceOf(address(this));
        if(_wantBal < _debtOutstanding){
			_withdrawSome(_debtOutstanding - _wantBal);
            return;
        }
        if (_wantBal > minWant + reserves) {
            if (activePosition == 0 ) {
                openPosition(_wantBal - reserves);
            } else {
                uint256[] memory newPosition = _calcDesiredPosition(_wantBal - reserves, true);
                _adjustPosition(newPosition);
            }
        }
    }

    /// @notice Tokens protected by strategy - want tokens are protected by default
    function protectedTokens() internal view override returns (address[] memory) {
    }

    function prepareMigration(address _newStrategy) internal override {
        require(activePosition == 0, 'prepareMigration: active position');
        //want.safeTransfer(want.balanceOf(address(this)), _newStrategy);
    }
}
