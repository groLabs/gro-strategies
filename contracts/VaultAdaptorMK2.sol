// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./common/Constants.sol";
import "./common/Whitelist.sol";
import "./interfaces/IVaultMK2.sol";
import "./interfaces/IERC20Detailed.sol";

interface IStrategy {
    function want() external view returns (address);
    function vault() external view returns (address);
    function isActive() external view returns (bool);
    function estimatedTotalAssets() external view returns (uint256);
    function withdraw(uint256 _amount) external returns (uint256);
    function migrate(address _newStrategy) external;
    function harvestTrigger(uint256 callCost) external view returns (bool);
    function harvest() external;
    function ammCheck(uint256 _check, uint256 _minAmount) external view returns (bool);
}

/// @notice VaultAdapterMk2 - Gro protocol vault that handles risk tranching with strategies.
///
///     Desing is based on a modified version of the yearnV2Vault
///
///     ###############################################
///     Vault Adaptor specifications
///     ###############################################
///
///     - Deposit: A deposit will move assets into the vault adaptor, which will be
///         available for investment into the underlying strategies
///     - Withdrawal: A withdrawal will always attempt to pull from the vaultAdaptor if possible,
///         if the assets in the adaptor fail to cover the withdrawal, the adaptor will
///         attempt to withdraw assets from the underlying strategies.
///     - Asset availability:
///         - VaultAdaptor:
///         - Strategies
///     - Debt ratios: Ratio in %BP of assets to invest in the underlying strategies of a vault
contract VaultAdaptorMK2 is Constants, Whitelist, IVaultMK2, ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 constant public MAXIMUM_STRATEGIES = 5;
    address constant ZERO_ADDRESS = address(0);

    // Underlying token
    address public immutable override token;
    uint256 private immutable _decimals;
    // Open up the harvest function to the public

    struct StrategyParams {
        uint256 activation;
        bool active;
        uint256 debtRatio;
        uint256 minDebtPerHarvest;
        uint256 maxDebtPerHarvest;
        uint256 lastReport;
        uint256 totalDebt;
        uint256 totalGain;
        uint256 totalLoss;
    }

    mapping(address => StrategyParams) public strategies;
    mapping(address => uint256) public userAllowance;

    address[MAXIMUM_STRATEGIES] public withdrawalQueue;
    
    uint256 public debtRatio;
    uint256 public totalDebt;
    uint256 public lastReport;
    uint256 public activation;
    uint256 public depositLimit;

    address public bouncer;
    
    event LogStrategyAdded(address indexed strategy, uint256 debtRatio, uint256 minDebtPerHarvest, uint256 maxDebtPerHarvest);
    event LogStrategyReported(address indexed strategy, uint256 gain, uint256 loss, uint256 debtPaid, uint256 totalGain, uint256 totalLoss, uint256 totalDebt, uint256 debtAdded, uint256 debtRatio);
    event LogUpdateWithdrawalQueue(address[] queue);
    event LogStrategyUpdateDebtRatio(address indexed strategy, uint256 debtRatio);
    event LogStrategyUpdateMinDebtPerHarvest(address indexed strategy, uint256 minDebtPerHarvest);
    event LogStrategyUpdateMaxDebtPerHarvest(address indexed strategy, uint256 maxDebtPerHarvest);
    event LogStrategyMigrated(address indexed newStrategy, address indexed oldStrategy);
    event LogStrategyRevoked(address indexed strategy);
    event LogStrategyRemovedFromQueue(address indexed strategy);
    event LogStrategyAddedToQueue(address indexed strategy);
    event LogStrategyStatusUpdate(address indexed strategy, bool status);

    event LogDepositLimit(uint256 newLimit);
    event LogDebtRatios(uint256[] strategyRetios);
    event LogMigrate(address parent, address child, uint256 amount);
    event LogNewBouncer(address bouncer);
    event LogNewStrategyHarvest(bool loss, uint256 change);
    event LogNewAllowance(address user, uint256 amount);
    event LogDeposit(address indexed from, uint256 _amount, uint256 shares, uint256 allowance);
    event LogWithdrawal(address indexed from, uint256 value, uint256 shares, uint256 totalLoss, uint256 allowance);

    constructor(address _token, address _bouncer) ERC20(
        string(abi.encodePacked(IERC20Detailed(_token).symbol(), " vault")),
        string(abi.encodePacked("gro", IERC20Detailed(_token).symbol()))
    ) {
        token = _token;
        _decimals = IERC20Detailed(_token).decimals();
        bouncer = _bouncer;
    }

    /// @notice Vault share decimals
    function decimals() public view override returns (uint8) {
        return uint8(_decimals);
    }
   
    /// @notice Total limit for vault deposits
    function setDepositLimit(uint256 newLimit) external onlyOwner {
        depositLimit = newLimit;
        emit LogDepositLimit(newLimit);
    }

    /// @notice Limit for how much individual users are allowed to deposit
    function setUserAllowance(address _user, uint256 _amount) external {
        require(msg.sender == bouncer, 'setUserAllowance: msg.sender != bouncer');
        userAllowance[_user] = _amount;
        emit LogNewAllowance(_user, _amount);
    }

    /// @notice Calculate system total assets
    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    /// @notice Get number of strategies in underlying vault
    function getStrategiesLength() external view override returns (uint256) {
        return strategyLength();
    }

    /// @notice Get total amount invested in strategy
    /// @param index Index of strategy
    function getStrategyAssets(uint256 index) external view override returns (uint256 amount) {
        return _getStrategyTotalAssets(index);
    }

    /// @notice Deposit assets into the vault adaptor
    /// @param _amount Deposit amount
    function deposit(uint256 _amount) external nonReentrant returns (uint256) {

        require(_amount > 0, 'deposit: _amount !> 0');
        require(_totalAssets() + _amount <= depositLimit, 'deposit: !depositLimit');
        require(userAllowance[msg.sender] >= _amount, 'deposit: !userAllowance');

        uint256 shares = _issueSharesForAmount(msg.sender, _amount);

        IERC20 _token = IERC20(token);
        _token.safeTransferFrom(msg.sender, address(this), _amount);

        uint256 _allowance = userAllowance[msg.sender] -  _amount;
        userAllowance[msg.sender] = _allowance;
        emit LogDeposit(msg.sender, _amount, shares, _allowance);
        return shares;
    }

    /// @notice Mint shares for user based on deposit amount
    /// @param _to recipient
    /// @param _amount amount of want deposited
    function _issueSharesForAmount(address _to, uint256 _amount) internal returns (uint256) {
        uint256 shares = 0;
        uint256 _totalSupply = totalSupply();
        if (_totalSupply > 0) {
            shares = _amount * _totalSupply / _totalAssets();
        } else {
            shares = _amount;
        }
        // unlikely to happen, just here for added safety
        require(shares != 0, '_issueSharesForAmount: shares == 0');
        _mint(_to, shares);

        return shares;
    }

    /// @notice Check if underlying strategy needs to be harvested
    /// @param index Index of stratey
    /// @param callCost Cost of harvest in underlying token
    function strategyHarvestTrigger(uint256 index, uint256 callCost) external view override returns (bool) {
        require(index < strategyLength(), "invalid index");
        return IStrategy(withdrawalQueue[index]).harvestTrigger(callCost);
    }

    /// @notice Harvest underlying strategy
    /// @param _index Index of strategy
    /// @param _check Amount to check against AMM if applicable
    /// @param _minAmount minAmount to expect to get out of AMM
    /// @dev Any Gains/Losses incurred by harvesting a streategy is accounted for in the vault adapter
    ///     and reported back to the Controller, which in turn updates current system total assets
    function strategyHarvest(
        uint256 _index,
        uint256 _check,
        uint256 _minAmount
    ) external nonReentrant onlyWhitelist {
        require(_index < strategyLength(), "invalid index");
        IStrategy _strategy = IStrategy(withdrawalQueue[_index]);
        uint256 beforeAssets = _totalAssets();
        if (_check > 0) {
            require(_strategy.ammCheck(_check, _minAmount), 'strategyHarvest: !ammCheck');
        }
        _strategy.harvest();
        uint256 afterAssets = _totalAssets();
        bool loss;
        uint256 change;
        if (beforeAssets > afterAssets) {
            change = beforeAssets - afterAssets;
            loss = true;
        } else {
            change = afterAssets - beforeAssets;
            loss = false;
        }
        emit LogNewStrategyHarvest(loss, change);
    }

    /// @notice Calculate system total assets including estimated profits
    function totalEstimatedAssets() external view returns (uint256) {
        uint256 total = IERC20(token).balanceOf(address(this));
        for (uint256 i = 0; i < strategyLength(); i++) {
            total += _getStrategyEstimatedTotalAssets(i);
        }
        return total;
    }
    
    /// @notice Update the withdrawal queue
    /// @param queue New withdrawal queue order
    function setWithdrawalQueue(address[] calldata queue) external onlyOwner {
        require(queue.length <= MAXIMUM_STRATEGIES, 'setWithdrawalQueue: > MAXIMUM_STRATEGIES');
        for(uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if(i >= queue.length) {
                withdrawalQueue[i] = address(0);
            } else {
                withdrawalQueue[i] = queue[i];
            }
            emit LogUpdateWithdrawalQueue(queue);
        }
    }
    
    /// @notice Number of active strategies in the vaultAdapter
    function strategyLength() internal view returns (uint256){
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == address(0)){
                return i;
            }
        }
        return MAXIMUM_STRATEGIES;
    }

    /// @notice Update the debtRatio of a specific strategy
    /// @param strategy Target strategy
    /// @param _debtRatio new debt ratio
    function setDebtRatio(address strategy, uint256 _debtRatio) external {
        // If a strategy isnt the source of the call
        require(strategies[strategy].active, 'setDebtRatio: !active');
        require(msg.sender == owner() || whitelist[msg.sender], 'setDebtRatio: !whitelist');
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'setDebtRatio: debtRatio > 100%');
        emit LogStrategyUpdateDebtRatio(strategy, _debtRatio);
    }

    /// @notice Set new strategy debt ratios
    /// @param StrategyDebtRatios Array of new debt ratios
    /// @dev Can be used to forecfully change the debt ratios of the underlying strategies
    ///     by whitelisted parties/owner
    function setDebtRatios(uint256[] memory StrategyDebtRatios) external {
        require(
            msg.sender == owner() || whitelist[msg.sender],
            "setDebtRatios: !whitelist"
        );
        require(StrategyDebtRatios.length <= MAXIMUM_STRATEGIES, 'setDebtRatios: > MAXIMUM_STRATEGIES');
        address _strategy;
        uint256 _ratio;
        for(uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            _strategy = withdrawalQueue[i];
            if (_strategy == address(0)) {
                break;
            } else {
                _ratio = StrategyDebtRatios[i];
            }
            _setStrategyDebtRatio(_strategy, _ratio);
        }
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'setDebtRatios: debtRatio > 100%');
    }
        
    /// @notice Add a new strategy to the vault adapter
    /// @param strategy Target strategy to add
    /// @param _debtRatio Target debtRatio of strategy
    /// @param minDebtPerHarvest Min amount of debt the strategy can take on per harvest
    /// @param maxDebtPerHarvest Max amount of debt the strategy can take on per harvest
    function addStrategy(address strategy, uint256 _debtRatio, uint256 minDebtPerHarvest, uint256 maxDebtPerHarvest) external onlyOwner {
        require(withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS, 'addStrategy: > MAXIMUM_STRATEGIES');
        require(strategy != ZERO_ADDRESS, 'addStrategy: address(0x)');
        require(!strategies[strategy].active, 'addStrategy: !activated');
        require(address(this) == IStrategy(strategy).vault(), 'addStrategy: !vault');
        require(debtRatio + _debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'addStrategy: debtRatio > 100%');
        require(minDebtPerHarvest <= maxDebtPerHarvest, 'addStrategy: min > max');
        
        StrategyParams storage newStrat = strategies[strategy];
        newStrat.activation = block.timestamp;
        newStrat.active = true;
        newStrat.debtRatio = _debtRatio;
        newStrat.minDebtPerHarvest = minDebtPerHarvest;
        newStrat.maxDebtPerHarvest = maxDebtPerHarvest;
        newStrat.lastReport = block.timestamp;
        
        emit LogStrategyAdded(strategy, debtRatio, minDebtPerHarvest, maxDebtPerHarvest);
    
        debtRatio += _debtRatio;
    
        withdrawalQueue[strategyLength()] = strategy;
        _organizeWithdrawalQueue();
    }
    
    function updateStrategyMinDebtPerHarvest(address strategy, uint256 minDebtPerHarvest) external onlyOwner {
        require(strategies[strategy].activation > 0, 'updateStrategyMinDebtPerHarvest: !activated');
        require(strategies[strategy].maxDebtPerHarvest >= minDebtPerHarvest, 'updateStrategyMinDebtPerHarvest: min > max');
        
        strategies[strategy].minDebtPerHarvest = minDebtPerHarvest;
        emit LogStrategyUpdateMinDebtPerHarvest(strategy, minDebtPerHarvest);
    }
    
    function updateStrategyMaxDebtPerHarvest(address strategy, uint256 maxDebtPerHarvest) external onlyOwner {
        require(strategies[strategy].activation > 0, 'updateStrategyMaxDebtPerHarvest: !activated');
        require(strategies[strategy].minDebtPerHarvest <= maxDebtPerHarvest, 'updateStrategyMaxDebtPerHarvest: min > max');
        
        strategies[strategy].maxDebtPerHarvest = maxDebtPerHarvest;
        emit LogStrategyUpdateMaxDebtPerHarvest(strategy, maxDebtPerHarvest);
    }
    
    /// @notice Replace existing strategy with a new one, removing he old one from the vault adapters
    ///     active strategies
    /// @param oldVersion address of old strategy
    /// @param newVersion address of new strategy
    function migrateStrategy(address oldVersion, address newVersion) external onlyOwner {
        require(newVersion != ZERO_ADDRESS, 'migrateStrategy: 0x');
        require(strategies[oldVersion].activation > 0, 'migrateStrategy: oldVersion !activated');
        require(strategies[oldVersion].active, 'migrateStrategy: oldVersion !active');
        require(strategies[newVersion].activation == 0, 'migrateStrategy: newVersion activated');
    
        StrategyParams storage _strategy = strategies[oldVersion];
    
        debtRatio += _strategy.debtRatio;

        StrategyParams storage newStrat = strategies[newVersion];
        newStrat.activation = block.timestamp;
        newStrat.active = true;
        newStrat.debtRatio = _strategy.debtRatio;
        newStrat.minDebtPerHarvest = _strategy.minDebtPerHarvest;
        newStrat.maxDebtPerHarvest = _strategy.maxDebtPerHarvest;
        newStrat.lastReport = _strategy.lastReport;
        newStrat.totalDebt = _strategy.totalDebt;
        newStrat.totalDebt = 0;
        newStrat.totalGain = 0;
        newStrat.totalLoss = 0;
    
        IStrategy(oldVersion).migrate(newVersion);

        _strategy.totalDebt = 0;
        _strategy.minDebtPerHarvest = 0;
        _strategy.maxDebtPerHarvest = 0;
    
        emit LogStrategyMigrated(oldVersion, newVersion);
    
        _revokeStrategy(oldVersion);

        for (uint256 i; i < MAXIMUM_STRATEGIES; i ++) {
            if (withdrawalQueue[i] == oldVersion) {
                withdrawalQueue[i] = newVersion;
                return;
            }
        }
    }

    /// @notice Remove strategy from vault adapter, called by strategy on emergencyExit
    function revokeStrategy() external {
        require(strategies[msg.sender].active, 'revokeStrategy: strategy not active');
        _revokeStrategy(msg.sender);
    }
    
    /// @notice Manually add a strategy to the withdrawal queue
    /// @param strategy Target strategy to add
    function addStrategyToQueue(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender], 'addStrategyToQueue: !owner|whitelist');
        require(strategies[strategy].activation > 0, 'addStrategyToQueue: !activated');
        require(withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS, 'addStrategyToQueue: queue full');
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            address _strategy = withdrawalQueue[i];
            if (_strategy == ZERO_ADDRESS) break;
            require(_strategy != strategy, 'addStrategyToQueue: strategy already in queue');
        }
        withdrawalQueue[MAXIMUM_STRATEGIES - 1] = strategy;
        _organizeWithdrawalQueue();
        emit LogStrategyAddedToQueue(strategy);
    }
    
    /// @notice Manually remove a strategy to the withdrawal queue
    /// @param strategy Target strategy to remove
    function removeStrategyFromQueue(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender], 'removeStrategyFromQueue: !owner|whitelist');
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == strategy) {
                withdrawalQueue[i] = ZERO_ADDRESS;
                _organizeWithdrawalQueue();
                emit LogStrategyRemovedFromQueue(strategy);
                return;
            }
        }
    }
    
    /// @notice Check how much credits are available for the strategy
    /// @param _strategy Target strategy
    function creditAvailable(address _strategy) external view returns (uint256) {
        return _creditAvailable(_strategy);
    }

    /// @notice Same as above but called by the streategy
    function creditAvailable() external view returns (uint256) {
        return _creditAvailable(msg.sender);
    }
    
    /// @notice Calculate the amount of assets the vault has available for the strategy to pull and invest,
    ///     the available credit is based of the strategies debt ratio and the total available assets
    ///     the vault has
    /// @param strategy Target strategy
    /// @dev Called during harvest
    function _creditAvailable(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 vault_totalAssets = _totalAssets();
        uint256 vault_debtLimit = debtRatio * vault_totalAssets / PERCENTAGE_DECIMAL_FACTOR;
        uint256 vault_totalDebt = totalDebt;
        uint256 strategy_debtLimit = _strategyData.debtRatio * vault_totalAssets / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategy_totalDebt = _strategyData.totalDebt;
        uint256 strategy_minDebtPerHarvest = _strategyData.minDebtPerHarvest;
        uint256 strategy_maxDebtPerHarvest = _strategyData.maxDebtPerHarvest;
        
        IERC20 _token = IERC20(token);
        
        if(strategy_debtLimit <= strategy_totalDebt || vault_debtLimit <= vault_totalDebt) {
            return 0;
        }
    
        uint256 available = strategy_debtLimit - strategy_totalDebt;
    
        available = Math.min(available, vault_debtLimit - vault_totalDebt);

        available = Math.min(available, _token.balanceOf(address(this)));

        if (available < strategy_minDebtPerHarvest) {
            return 0;
        } else{
            return Math.min(available, strategy_maxDebtPerHarvest);
        }
    }
    
    /// @notice Deal with any loss that a strategy has realized
    /// @param strategy target strategy
    /// @param loss amount of loss realized
    function _reportLoss(address strategy, uint256 loss) internal {
        StrategyParams storage _strategy = strategies[strategy];
        // Loss can only be up the amount of debt issued to strategy
        require(_strategy.totalDebt >= loss, '_reportLoss: totalDebt >= loss');
        // Add loss to srategy and remove loss from strategyDebt
        _strategy.totalLoss += loss;
        _strategy.totalDebt -= loss;
        totalDebt -= loss;
    }
    
    /// @notice Amount by which a strategy exceeds its current debt limit
    /// @param strategy target strategy
    function _debtOutstanding(address strategy) internal view returns (uint256) {
        StrategyParams storage _strategy = strategies[strategy];
        uint256 strategy_debtLimit = _strategy.debtRatio * _totalAssets() / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategy_totalDebt = _strategy.totalDebt;
    
        if (strategy_totalDebt <= strategy_debtLimit) {
            return 0;
        } else {
            return strategy_totalDebt - strategy_debtLimit;
        }
    }
    
    /// @notice Amount of debt the strategy has to pay back to the vault at next harvest
    function debtOutstanding(address strategy) external view returns (uint256) {
        return _debtOutstanding(strategy);
    }
    
    function debtOutstanding() external view returns (uint256) {
        return _debtOutstanding(msg.sender);
    }

    function strategyDebt() external view returns (uint256) {
        return strategies[msg.sender].totalDebt;
    }

    /// @notice Remove unwanted token from contract
    /// @param _token Address of unwanted token, cannot be want token
    /// @param recipient Reciever of unwanted token 
    function sweep(address _token, address recipient) external onlyOwner {
        require(_token != token, 'sweep: token == want');
        uint256 amount = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(recipient, amount);
    }
    
    /// @notice Withdraw desired amount from vault adapter, if the reserves are unable to
    ///     to cover the desired amount, start withdrawing from strategies in order specified.
    ///     The withdrawamount if set in shares and calculated in the underlying token the vault holds.
    /// @param _shares Amount to withdraw in shares
    /// @param _maxLoss Max accepted loss when withdrawing from strategy
    function withdraw(uint256 _shares, uint256 _maxLoss) external nonReentrant returns (uint256) {
        require(_maxLoss <= PERCENTAGE_DECIMAL_FACTOR, 'withdraw: _maxLoss > 100%');
        require(_shares > 0, 'withdraw: _shares == 0');

        uint256 userBalance = balanceOf(msg.sender);
        uint256 shares = _shares == type(uint256).max ? balanceOf(msg.sender) : _shares;
        require(shares <= userBalance, 'withdraw, shares > userBalance');
        uint256 value = _shareValue(shares);

        IERC20 _token = IERC20(token);
        uint256 totalLoss = 0;
        // If reserves dont cover the withdrawal, start withdrawing from strategies
        if (value > _token.balanceOf(address(this))) {
            address[MAXIMUM_STRATEGIES] memory _strategies = withdrawalQueue;
            for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
                address _strategy = _strategies[i];
                if (_strategy == ZERO_ADDRESS) break;
                uint256 vaultBalance = _token.balanceOf(address(this));
                // break if we have withdrawn all we need 
                if (value <= vaultBalance) break;
                uint256 amountNeeded = value - vaultBalance;
    
                StrategyParams storage _strategyData = strategies[_strategy];
                amountNeeded = Math.min(amountNeeded, _strategyData.totalDebt);
                // If nothing is needed or strategy has no assets, continue
                if (amountNeeded == 0) {
                    continue;
                }
    
                uint256 loss = IStrategy(_strategy).withdraw(amountNeeded);
                // Amount withdraw from strategy
                uint256 withdrawn = _token.balanceOf(address(this)) - vaultBalance;
    
                // Handle the loss if any
                if (loss > 0) {
                    value = value - loss;
                    totalLoss = totalLoss + loss;
                    _reportLoss(_strategy, loss);
                }
                // Remove withdrawn amount from strategy and vault debts
                _strategyData.totalDebt -= withdrawn;
                totalDebt -= withdrawn;
            }
            uint256 finalBalance = _token.balanceOf(address(this));
            // If we dont have enough assets to cover the withdrawal, lower it
            //      to what we have, this should technically never happen
            if (value > finalBalance) {
                value = finalBalance;
                shares = _sharesForAmount(value + totalLoss);
            }
            
            require(totalLoss <= _maxLoss * (value + totalLoss) / PERCENTAGE_DECIMAL_FACTOR, 'withdraw: loss > maxloss');
        }
        _burn(msg.sender, shares);
        _token.safeTransfer(msg.sender, value);
        // Hopefully get a bit more allowance - thx for participating!
        uint256 _allowance = userAllowance[msg.sender] + (value + totalLoss);
        userAllowance[msg.sender] = _allowance;
        

        emit LogWithdrawal(msg.sender, value, shares, totalLoss, _allowance);
        return value;
    }
    
    /// @notice Value of shares in underlying token
    /// @param _shares amount of shares to convert to tokens
    function _shareValue(uint256 _shares) internal view returns (uint256) {
        uint256 _totalSupply = totalSupply();
        if (_totalSupply == 0) return _shares;
        return (_shares * _totalAssets() / _totalSupply);
    }

    /// @notice Value of tokens in shares
    /// @param _amount amount of tokens to convert to shares
    function  _sharesForAmount(uint256 _amount) internal view returns (uint256) {
        uint256 _assets = _totalAssets();
        if (_assets > 0) {
            return  _amount * totalSupply() / _assets;
        } else {
            // unlikely to happen, but here for safety
            return 0;
        }
    }

    /// @notice Report back any gains/losses from a (strategy) harvest, vault adapetr
    ///     calls back debt or gives out more credit to the strategy depending on available
    ///     credit and the strategies current position.
    /// @param gain Strategy gains from latest harvest
    /// @param loss Strategy losses from latest harvest
    /// @param _debtPayment Amount strategy can pay back to vault
    function report(uint256 gain, uint256 loss, uint256 _debtPayment) external returns (uint256) {
        StrategyParams storage _strategy = strategies[msg.sender];
        require(_strategy.active, 'report: !activated');
        IERC20 _token = IERC20(token);
        require(_token.balanceOf(msg.sender) >= gain + _debtPayment, 'report: to much gain');

        if (loss > 0) {
            _reportLoss(msg.sender, loss);
        }
        
        _strategy.totalGain = _strategy.totalGain + gain;
    
        uint256 debt = _debtOutstanding(msg.sender);
        uint256 debtPayment = Math.min(_debtPayment, debt);
    
        if (debtPayment > 0) {
            _strategy.totalDebt = _strategy.totalDebt - debtPayment;
            totalDebt -= debtPayment;
            debt -= debtPayment;
        }
        
        uint256 credit = _creditAvailable(msg.sender);
    
        if (credit > 0) {
            _strategy.totalDebt += credit;
            totalDebt += credit;
        }
    
        uint256 totalAvailable = gain + debtPayment;
        if (totalAvailable < credit) {
            _token.safeTransfer(msg.sender, credit - totalAvailable);
        } else if (totalAvailable > credit) {
            _token.safeTransferFrom(msg.sender, address(this), totalAvailable - credit);
        }
    
        lastReport = block.timestamp;
        _strategy.lastReport = lastReport;
    
        emit LogStrategyReported(
            msg.sender,
            gain,
            loss,
            debtPayment,
            _strategy.totalGain,
            _strategy.totalLoss,
            _strategy.totalDebt,
            credit,
            _strategy.debtRatio
        );
    
        if (_strategy.debtRatio == 0) {
            return IStrategy(msg.sender).estimatedTotalAssets();
        } else {
            return debt;
        }
    }

    function _setStrategyDebtRatio(address strategy, uint256 _debtRatio) internal {
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        emit LogStrategyUpdateDebtRatio(strategy, _debtRatio);
    }

    /// @notice Gives the price for a single Vault share.
    /// @dev See dev note on `withdraw`.
    /// @return The value of a single share.
    function getPricePerShare() external view returns (uint256) {
		return _shareValue(10 ** _decimals);
    }

    /// @notice Get current enstimated amount of assets in strategy
    /// @param _index index of strategy
    function _getStrategyEstimatedTotalAssets(uint256 _index) internal view returns (uint256) {
        return IStrategy(withdrawalQueue[_index]).estimatedTotalAssets();
    }

    /// @notice Get strategy totalDebt
    /// @param _index index of strategy
    function _getStrategyTotalAssets(uint256 _index) internal view returns (uint256) {
        StrategyParams storage strategy = strategies[withdrawalQueue[_index]];
        return strategy.totalDebt;
    }
    
    /// @notice Remove strategy from vault
    /// @param _strategy address of strategy
    function _revokeStrategy(address _strategy) internal {
        debtRatio -= strategies[_strategy].debtRatio;
        strategies[_strategy].debtRatio = 0;
        strategies[_strategy].active = false;
        emit LogStrategyRevoked(_strategy);
    }
    
    function _totalAssets() private view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) + totalDebt;
    }
    
    function _organizeWithdrawalQueue() internal {
        uint256 offset;
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            address strategy = withdrawalQueue[i];
            if (strategy == ZERO_ADDRESS) {
                offset += 1;
            } else if (offset > 0) {
                withdrawalQueue[i - offset] = strategy;
                withdrawalQueue[i] = ZERO_ADDRESS;
            }
        }
    }
}
