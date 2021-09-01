// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.3;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./common/Controllable.sol";
import "./common/Constants.sol";
import "./common/Whitelist.sol";
import "./interfaces/IVaultMK2.sol";
import "./interfaces/IController.sol";
import "./interfaces/IERC20Detailed.sol";

interface Strategy {
    function want() external view returns (address);
    function vault() external view returns (address);
    function isActive() external view returns (bool);
    function estimatedTotalAssets() external view returns (uint256);
    function withdraw(uint256 _amount) external returns (uint256);
    function migrate(address _newStrategy) external;
    function harvestTrigger(uint256 callCost) external view returns (bool);
    function harvest() external;
}

/// @notice Base contract for gro protocol vault adaptors - Vault adaptors act as a
///     layer between the protocol and any yield aggregator vault. They provides additional
///     functionality needed by the protocol, and allow the protocol to be agnostic
///     to the type of underlying vault it interacts with.
///
///     ###############################################
///     Base Vault Adaptor specifications
///     ###############################################
///
///     Any deposit/withdrawal into the system will always attempt to interact with the
///     appropriate vault adaptor (depending on token).
///     - Deposit: A deposit will move assets into the vault adaptor, which will be
///         available for investment into the underlying vault once a large enough amount
///         of assets has amassed in the vault adaptor.
///     - Withdrawal: A withdrawal will always attempt to pull from the vaultAdaptor if possible,
///         if the assets in the adaptor fail to cover the withdrawal, the adaptor will
///         attempt to withdraw assets from the underlying vaults strategies. The latter will
///         also depend on whether pwrd or gvt is being withdrawn, as strategy assets affect
///         system exposure levels.
///     - Invest: Once a significant amount of assets have amassed in the vault adaptor, the
///         invest trigger will signal that the adaptor is ready to invest assets. The adaptor
///         always aims to hold a percent of total assets as univested assets (vaultReserve).
///         This allows for smaller withdrawals to be cheaper as they dont have to interact with
///         the underlying strategies.
///     - Debt ratios: Ratio in %BP of assets to invest in the underlying strategies of a vault
contract VaultAdaptorMK2 is Controllable, Constants, Whitelist, IVaultMK2 {
    using SafeERC20 for IERC20;

    uint256 constant public MAXIMUM_STRATEGIES = 4;
    address constant ZERO_ADDRESS = address(0);

    // Underlying token
    address public immutable override token;
    uint256 public immutable decimals;
    // Used to establish if the strategy debt ratios need to be updated
    uint256 public StrategyDebtRatioBuffer;
    // How much of total assets should be held in the vault adaptor (%BP)
    uint256 public vaultReserve;
    // Open up the harvest function to the public
    bool public openHarvest;
    bool public entered;
    uint256 public gasBounty;
    uint256 public baseProfit;

    struct StrategyParams {
        uint256 activation;
        uint256 debtRatio;
        uint256 minDebtPerHarvest;
        uint256 maxDebtPerHarvest;
        uint256 lastReport;
        uint256 totalDebt;
        uint256 totalGain;
        uint256 totalLoss;
    }

    mapping(address => StrategyParams) public strategies;
    address[MAXIMUM_STRATEGIES] public withdrawalQueue;
    
    uint256 public debtRatio;
    uint256 public totalDebt;
    uint256 public lastReport;
    uint256 public activation;
    
    string public constant apiVersion = "0.3.2";
    string public name;

    event StrategyAdded(address indexed strategy, uint256 debtRatio, uint256 minDebtPerHarvest, uint256 maxDebtPerHarvest);
    event StrategyReported(address indexed strategy, uint256 gain, uint256 loss, uint256 debtPaid, uint256 totalGain, uint256 totalLoss, uint256 totalDebt, uint256 debtAdded, uint256 debtRatio);
    event UpdateWithdrawalQueue(address[] queue);
    event StrategyUpdateDebtRatio(address indexed strategy, uint256 debtRatio);
    event StrategyUpdateMinDebtPerHarvest(address indexed strategy, uint256 minDebtPerHarvest);
    event StrategyUpdateMaxDebtPerHarvest(address indexed strategy, uint256 maxDebtPerHarvest);
    event StrategyMigrated(address indexed newStrategy, address indexed oldStrategy);
    event StrategyRevoked(address indexed strategy);
    event StrategyRemovedFromQueue(address indexed strategy);
    event StrategyAddedToQueue(address indexed strategy);
    event LogWithdrawal(); // TODO fill this event

    event LogAdaptorReserve(uint256 reserve);
    event LogNewAdaptorStrategyBuffer(uint256 buffer);
    event LogNewDebtRatios(uint256[] strategyRetios);
    event LogMigrate(address parent, address child, uint256 amount);

        
    constructor(address _token) public {
        token = _token;
        name = string(abi.encodePacked(IERC20Detailed(_token).symbol(), " vault"));
        uint256 _decimals = IERC20Detailed(_token).decimals();
        baseProfit = uint256(100) * (uint256(10)**_decimals);
        decimals = _decimals;
    }

    function setVaultReserve(uint256 reserve) external onlyOwner {
        require(reserve <= PERCENTAGE_DECIMAL_FACTOR);
        vaultReserve = reserve;
        emit LogAdaptorReserve(reserve);
    }

    function setStrategyDebtRatioBuffer(uint256 _strategyDebtRatioBuffer) external onlyOwner {
        StrategyDebtRatioBuffer = _strategyDebtRatioBuffer;
        emit LogNewAdaptorStrategyBuffer(_strategyDebtRatioBuffer);
    }

    function setOpenHarvest(bool status) external onlyOwner {
        openHarvest = status;
    }

    function setGasBounty(uint256 bounty) external onlyOwner {
        gasBounty = bounty;
    }

    /// @notice Calculate system total assets
    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    /// @notice Get number of strategies in underlying vault
    function getStrategiesLength() external view override returns (uint256) {
        return strategyLength();
    }

    /// @notice Withdraw assets from underlying vault
    /// @param amount Amount to withdraw
    /// @dev Sends assets to msg.sender
    function withdraw(uint256 amount) external override {
        require(msg.sender == ctrl().lifeGuard(), "withdraw: !lifeguard");
        _withdraw(0, amount, msg.sender, 1);
    }

    /// @notice Withdraw assets from underlying vault
    /// @param amount Amount to withdraw
    /// @param recipient Target recipient
    /// @dev Will try to pull assets from adaptor before moving on to pull
    ///     assets from unerlying vault/strategies
    function withdraw(uint256 amount, address recipient) external override {
        require(msg.sender == ctrl().insurance(), "withdraw: !insurance");
        _withdraw(0, amount, recipient, 1);
    }

    /// @notice Withdraw assets from vault to vault adaptor
    /// @param amount Amount to withdraw
    function withdrawToAdapter(uint256 amount, uint256 maxLoss) external onlyWhitelist {
         _withdraw(0, amount, address(this), maxLoss);
    }

    /// @notice Withdraw assets from underlying vault, but do so in a specific strategy order
    /// @param amount Amount to withdraw
    /// @param recipient Target recipient
    /// @param reversed reverse strategy order
    /// @dev This is an addaptation for yearn v2 vaults - these vaults have a defined withdraw
    ///     order. Gro protocol needs to respect prtocol exposure, and thus might have to withdraw
    ///     from different strategies depending on if pwrd or gvts are withdrawn.
    function withdrawByStrategyOrder(
        uint256 amount,
        address recipient,
        bool reversed
    ) external override {
        IController _ctrl = ctrl();
        require(
            msg.sender == _ctrl.withdrawHandler() ||
                msg.sender == _ctrl.insurance() ||
                msg.sender == _ctrl.emergencyHandler(),
            "withdraw: !withdrawHandler|insurance|emergencyHandler"
        );
        uint256 strategyIndex;
        if (reversed) {
            strategyIndex = MAXIMUM_STRATEGIES;   
        }
        _withdrawByStrategyIndex(amount, recipient, strategyIndex);
    }

    /// @notice Withdraw assets from underlying vault, but do so from a specific strategy
    /// @param amount Amount to withdraw
    /// @param recipient Target recipient
    /// @param strategyIndex Index of target strategy
    /// @dev Same as for withdrawByStrategyOrder, but now we withdraw from a specific strategy.
    ///     This functionality exists to be able to move assets from overExposed strategies.
    function withdrawByStrategyIndex(
        uint256 amount,
        address recipient,
        uint256 strategyIndex
    ) external override {
        require(msg.sender == ctrl().insurance(), "withdraw: !insurance");
        _withdrawByStrategyIndex(amount, recipient, strategyIndex);
    }

    /// @notice Get total amount invested in strategy
    /// @param index Index of strategy
    function getStrategyAssets(uint256 index) external view override returns (uint256 amount) {
        return getStrategyTotalAssets(index);
    }

    /// @notice Deposit assets into the vault adaptor
    /// @param amount Deposit amount
    function deposit(uint256 amount) external override {
        require(msg.sender == ctrl().lifeGuard(), "deposit: !lifeguard");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Check if underlying strategy needs to be harvested
    /// @param index Index of stratey
    /// @param callCost Cost of harvest
    function strategyHarvestTrigger(uint256 index, uint256 callCost) external view override returns (bool harvested) {
        require(index < strategyLength(), "invalid index");
        return _strategyHarvestTrigger(index, callCost);
    }

    /// @notice Harvest underlying strategy
    /// @param index Index of strategy
    function strategyHarvest(uint256 index) external override returns (bool harvested) {
        require(!entered, "Harvest already running");
        require(index < strategyLength(), "invalid index");
        entered = true;
        // Check and update strategies debt ratio
        if (!openHarvest) {
            require(whitelist[msg.sender], "StrategyHarvest: !whitelist");
        }
        uint256 beforeAssets = _totalAssets();
        _strategyHarvest(index);
        uint256 afterAssets = _totalAssets();
        if (afterAssets > beforeAssets) {
            if (gasBounty > 0) {
                // Pass on a proportion of the profit to the user who called the harvest
                uint256 profit = afterAssets - beforeAssets;
                if (profit > baseProfit) {
                    uint256 reward = (profit * gasBounty) / 10000;
                    afterAssets = afterAssets - reward;
                    IERC20(token).safeTransfer(msg.sender, reward);
                }
            }
            ctrl().distributeStrategyGainLoss(afterAssets - beforeAssets, 0);
        } else if (afterAssets < beforeAssets) {
            ctrl().distributeStrategyGainLoss(0, beforeAssets - afterAssets);
        }
        harvested = true;
        entered = false;
    }

    /// @notice Migrate assets to new vault
    /// @param child target for migration
    function migrate(address child) external onlyOwner {
        require(child != address(0), "migrate: child == 0x");
        IERC20 _token = IERC20(token);
        uint256 balance = _token.balanceOf(address(this));
        _token.safeTransfer(child, balance);
        emit LogMigrate(address(this), child, balance);
    }

    /// @notice Calculate system total assets including estimated profits
    function totalEstimatedAssets() external view returns (uint256) {
        uint256 total = IERC20(token).balanceOf(address(this));
        for (uint256 i = 0; i < strategyLength(); i++) {
            total += getStrategyEstimatedTotalAssets(i);
        }
        return total;
    }
    
    function setName(string calldata _name) external onlyOwner {
        name = _name;
    }
    
    function setWithdrawalQueue(address[] calldata queue) external onlyOwner {
        require(queue.length <= MAXIMUM_STRATEGIES, 'setWithdrawalQueue: > MAXIMUM_STRATEGIES');
        for(uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if(i >= queue.length) {
                withdrawalQueue[i] = address(0);
            } else {
                withdrawalQueue[i] = queue[i];
            }
            emit UpdateWithdrawalQueue(queue);
        }
    }
    
    function strategyLength() internal view returns (uint256){
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == address(0)){
                return i;
            }
        }
        return MAXIMUM_STRATEGIES;
    }

    /// @notice Set new strategy debt ratios
    /// @param StrategyDebtRatios Array of new debt ratios
    function setStrategyDebtRatio(uint256[] memory StrategyDebtRatios) public override {
        require(
            msg.sender == ctrl().insurance() || msg.sender == owner() || whitelist[msg.sender],
            "!setStrategyDebtRatio: !owner|insurance"
        );
        require(StrategyDebtRatios.length <= MAXIMUM_STRATEGIES, 'setStrategyDebtRatio: > MAXIMUM_STRATEGIES');
        address _strategy;
        uint256 _ratio;
        for(uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            _strategy = withdrawalQueue[i];
            if (_strategy == address(0)) {
                continue;
            } else {
                _ratio = StrategyDebtRatios[i];
            }
            _setStrategyDebtRatio(_strategy, _ratio);
        }
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'updateStrategyDebtRatio: debtRatio > 100%');
    }


    function updateStrategyDebtRatioTrigger() public view returns(bool, uint256[] memory) {
        uint256 _strategyLength = strategyLength();
        require(_strategyLength > 1, 'updateStrategyDebtRatioTrigger: !strategyLength');
        uint256[] memory targetRatios = ctrl().getStrategiesTargetRatio();
        uint256[] memory currentRatios = getStrategiesDebtRatio();
        bool update;
        for (uint256 i; i < _strategyLength; i++) {
            if (currentRatios[i] < targetRatios[i] && targetRatios[i] - currentRatios[i] > StrategyDebtRatioBuffer) {
                update = true;
                break;
            }

            if (currentRatios[i] > targetRatios[i] && currentRatios[i] - targetRatios[i] > StrategyDebtRatioBuffer) {
                update = true;
                break;
            }
        }
        return (update, targetRatios);
    }

    function updateStrategyDebtRatio() external {
        (bool update, uint256[] memory ratios) = updateStrategyDebtRatioTrigger();
        require(update, 'updateStrategyDebtRatio: !update');
        setStrategyDebtRatio(ratios);
    }

    function _totalAssets() internal view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) + totalDebt;
    }
    
    function _totalAssetsAvailable() internal view returns (uint256) {
        return _totalAssets() * (PERCENTAGE_DECIMAL_FACTOR - vaultReserve) / PERCENTAGE_DECIMAL_FACTOR;
    }

    function updateStrategyDebtRatio(address strategy, uint256 _debtRatio) external override {
        if (strategies[msg.sender].activation == 0) {
            require(strategies[strategy].activation > 0, 'updateStrategyDebtRatio: !activated');
            require(msg.sender == owner() || whitelist[msg.sender], 'updateStrategyDebtRatio: !whitelist');
        }
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'updateStrategyDebtRatio: debtRatio > 100%');
        emit StrategyUpdateDebtRatio(strategy, _debtRatio);
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
        
    function addStrategy(address strategy, uint256 _debtRatio, uint256 minDebtPerHarvest, uint256 maxDebtPerHarvest) external onlyOwner {
        
        require(withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS, 'addStrategy: > MAXIMUM_STRATEGIES');
        require(strategy != ZERO_ADDRESS, 'addStrategy: address(0x)');
        require(strategies[strategy].activation == 0, 'addStrategy: !activated');
        require(address(this) == Strategy(strategy).vault(), 'addStrategy: !vault');
        require(token == Strategy(strategy).want(), 'addStrategy: !want');
        require(debtRatio + _debtRatio <= PERCENTAGE_DECIMAL_FACTOR, 'addStrategy: debtRatio > 100%');
        require(minDebtPerHarvest <= maxDebtPerHarvest, 'addStrategy: min > max');
        
        strategies[strategy] = StrategyParams({
            activation: block.timestamp,
            debtRatio: _debtRatio,
            minDebtPerHarvest: minDebtPerHarvest,
            maxDebtPerHarvest: maxDebtPerHarvest,
            lastReport: block.timestamp,
            totalDebt: 0,
            totalGain: 0,
            totalLoss: 0
        });
        
        emit StrategyAdded(strategy, debtRatio, minDebtPerHarvest, maxDebtPerHarvest);
    
        debtRatio += _debtRatio;
    
        withdrawalQueue[strategyLength()] = strategy;
        _organizeWithdrawalQueue();
    }
    
    function updateStrategyMinDebtPerHarvest(address strategy, uint256 minDebtPerHarvest) external onlyOwner {
        require(strategies[strategy].activation > 0, 'updateStrategyMinDebtPerHarvest: !activated');
        require(strategies[strategy].maxDebtPerHarvest >= minDebtPerHarvest, 'updateStrategyMinDebtPerHarvest: min > max');
        
        strategies[strategy].minDebtPerHarvest = minDebtPerHarvest;
        emit StrategyUpdateMinDebtPerHarvest(strategy, minDebtPerHarvest);
    }
    
    function updateStrategyMaxDebtPerHarvest(address strategy, uint256 maxDebtPerHarvest) external onlyOwner {
        require(strategies[strategy].activation > 0, 'updateStrategyMaxDebtPerHarvest: !activated');
        require(strategies[strategy].minDebtPerHarvest <= maxDebtPerHarvest, 'updateStrategyMaxDebtPerHarvest: min > max');
        
        strategies[strategy].maxDebtPerHarvest = maxDebtPerHarvest;
        emit StrategyUpdateMaxDebtPerHarvest(strategy, maxDebtPerHarvest);
    }
    
    function _revokeStrategy(address strategy) internal {
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = 0;
        emit StrategyRevoked(strategy);
    }
    
    function migrateStrategy(address oldVersion, address newVersion) external onlyOwner {
        require(newVersion != ZERO_ADDRESS, 'migrateStrategy: 0x');
        require(strategies[oldVersion].activation > 0, 'migrateStrategy: oldVersion !activated');
        require(strategies[newVersion].activation == 0, 'migrateStrategy: newVersion activated');
    
        StrategyParams memory _strategy = strategies[oldVersion];
    
        _revokeStrategy(oldVersion);

        debtRatio += _strategy.debtRatio;

        strategies[oldVersion].totalDebt = 0;
    
        strategies[newVersion] = StrategyParams({
            activation: _strategy.lastReport,
            debtRatio: _strategy.debtRatio,
            minDebtPerHarvest: _strategy.minDebtPerHarvest,
            maxDebtPerHarvest: _strategy.maxDebtPerHarvest,
            lastReport: _strategy.lastReport,
            totalDebt: _strategy.totalDebt,
            totalGain: 0,
            totalLoss: 0
        });
    
        Strategy(oldVersion).migrate(newVersion);
        emit StrategyMigrated(oldVersion, newVersion);
    
        for (uint256 i; i < MAXIMUM_STRATEGIES; i ++) {
            if (withdrawalQueue[i] == oldVersion) {
                withdrawalQueue[i] = newVersion;
                return;
            }
        }
    }

    function revokeStrategy(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender]);
        _revokeStrategy(strategy);
    }

    function revokeStrategy() external {
        _revokeStrategy(msg.sender);
    }
    
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
        emit StrategyAddedToQueue(strategy);
    }
    
    function removeStrategyFromQueue(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender], 'removeStrategyFromQueue: !owner|whitelist');
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == strategy) {
                withdrawalQueue[i] = ZERO_ADDRESS;
                _organizeWithdrawalQueue();
                emit StrategyRemovedFromQueue(strategy);
                return;
            }
        }
    }
    
    function _creditAvailable(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 vault_totalAssets = _totalAssetsAvailable();
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
    
    function creditAvailable() external view returns (uint256) {
        return _creditAvailable(msg.sender);
    }
    
    function creditAvailable(address _strategy) external view returns (uint256) {
        return _creditAvailable(_strategy);
    }

    function expectedReturn(address strategy) external view returns (uint256) {
        return _expectedReturn(strategy);
    }
    
    function _expectedReturn(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 strategy_lastReport = _strategyData.lastReport;
        uint256 timeSinceLastHarvest = block.timestamp - strategy_lastReport;
        uint256 totalHarvestTime = strategy_lastReport - _strategyData.activation;
    
        if(timeSinceLastHarvest > 0 && totalHarvestTime > 0 && Strategy(strategy).isActive()) {
            return _strategyData.totalGain * timeSinceLastHarvest / totalHarvestTime;
        } else {
            return 0;
        }
    }
    
    function _reportLoss(address strategy, uint256 loss) internal returns (uint256, uint256) {
        // Loss can only be up the amount of debt issued to strategy
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 _totalDebt = _strategyData.totalDebt;
        require(_totalDebt >= loss, '_reportLoss: totalDebt >= loss');
        uint256 _totalLoss = _strategyData.totalLoss + loss;
        strategies[strategy].totalLoss = _totalLoss;
        _totalDebt -= loss;
        strategies[strategy].totalDebt = _totalDebt;
        totalDebt -= loss;
        return (_totalLoss, _totalDebt); 
    }
    
    function _debtOutstanding(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 strategy_debtLimit = _strategyData.debtRatio * _totalAssetsAvailable() / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategy_totalDebt = _strategyData.totalDebt;
    
        if (strategy_totalDebt <= strategy_debtLimit) {
            return 0;
        } else {
            return strategy_totalDebt - strategy_debtLimit;
        }
    }
    
    function debtOutstanding(address strategy) external view returns (uint256) {
        return _debtOutstanding(strategy);
    }
    
    function debtOutstanding() external view returns (uint256) {
        return _debtOutstanding(msg.sender);
    }

    function sweep(address _token, address recipient) external onlyOwner {
        require(_token != token, 'sweep: token == want');
        uint256 amount = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(recipient, amount);
    }
    
    /// @notice Withdraw from vault adaptor, if withdrawal amount exceeds adaptors,
    ///     withdraw from a specific strategy
    /// @param amount Amount to withdraw
    /// @param recipient Recipient of withdrawal
    /// @param index Index of strategy
    function _withdrawByStrategyIndex(
        uint256 amount,
        address recipient,
        uint256 index
    ) internal returns (uint256) {
        return _withdraw(index, amount, recipient, 1);
    }

    function _strategyHarvest(uint256 index) internal {
        Strategy(withdrawalQueue[index]).harvest();
    }

    function _setStrategyDebtRatio(address strategy, uint256 _debtRatio) internal {
        require(strategies[strategy].activation > 0, '_setStrategyDebtRatio: !activated');
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        emit StrategyUpdateDebtRatio(strategy, _debtRatio);
    }

    /// @notice Return debt ratio of underlying strategies
    function getStrategiesDebtRatio() internal view returns (uint256[] memory ratios) {
        uint256 _strategyLength = strategyLength();
        ratios = new uint256[](_strategyLength);
        StrategyParams memory strategyParam;
        for (uint256 i; i < _strategyLength; i++) {
            strategyParam = strategies[withdrawalQueue[i]];
            ratios[i] = strategyParam.debtRatio;
        }
    }

    function _strategyHarvestTrigger(uint256 index, uint256 callCost) internal view returns (bool) {
        return Strategy(withdrawalQueue[index]).harvestTrigger(callCost);
    }

    function getStrategyEstimatedTotalAssets(uint256 index) internal view returns (uint256) {
        return Strategy(withdrawalQueue[index]).estimatedTotalAssets();
    }

    function getStrategyTotalAssets(uint256 index) internal view returns (uint256) {
        StrategyParams memory strategyParam = strategies[withdrawalQueue[index]];
        return strategyParam.totalDebt;
    }
    
    function _withdraw(uint256 index, uint256 _amount, address recipient, uint256 maxLoss) internal returns (uint256) {
        address[MAXIMUM_STRATEGIES] memory _strategies;
        address[MAXIMUM_STRATEGIES] memory _withdrawalQueue = withdrawalQueue;
        uint256 _strategyLength = strategyLength();
        uint256 value = _amount;

        IERC20 _token = IERC20(token);
        if (index == 0) {
             _strategies = _withdrawalQueue;
        } else if (index == MAXIMUM_STRATEGIES) {
            for (uint256 i = _strategyLength; i > 0; i--) {
                _strategies[i - 1] = _withdrawalQueue[(_strategyLength - i)];
            }
        } else {
            uint256 strategyIndex = 0;
            _strategies[strategyIndex] = _withdrawalQueue[index];
            for (uint256 i = 0; i < _strategyLength; i++) {
                if (_withdrawalQueue[i] == address(0)) break;
                if (i == index) continue;
                strategyIndex++;
                _strategies[strategyIndex] = _withdrawalQueue[i];
            }
        }
        uint256 totalLoss = 0;
        if (value > _token.balanceOf(address(this))) {
            for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
                address _strategy = _strategies[i];
                if (_strategy == ZERO_ADDRESS) break;
                uint256 vault_balance = _token.balanceOf(address(this));
                
                if (value <= vault_balance) break;
                uint256 amountNeeded = value - vault_balance;
    
                StrategyParams memory _strategyData = strategies[_strategy];
                amountNeeded = Math.min(amountNeeded, _strategyData.totalDebt);
                if (amountNeeded == 0) {
                    continue;
                }
    
                uint256 loss = Strategy(_strategy).withdraw(amountNeeded);
                uint256 withdrawn = _token.balanceOf(address(this)) - vault_balance;
    
                if (loss > 0) {
                    value = value - loss;
                    totalLoss = totalLoss + loss;
                    strategies[_strategy].totalLoss = _strategyData.totalLoss + loss;
                }
                strategies[_strategy].totalDebt = _strategyData.totalDebt - withdrawn + loss;
                totalDebt -= (withdrawn + loss);
            }
        }
        uint256 vault_balance = _token.balanceOf(address(this));
        if (value > vault_balance) {
            value = vault_balance;
        }
    
        require(totalLoss <= maxLoss * (value + totalLoss) / PERCENTAGE_DECIMAL_FACTOR);
    
        _token.safeTransfer(recipient, value);
        emit LogWithdrawal(); // TODO fill this event
        return value;
    }
    
    function report(uint256 gain, uint256 loss, uint256 _debtPayment) external returns (uint256) {
        StrategyParams memory _strategy = strategies[msg.sender];
        require(_strategy.activation > 0, 'report: !activated');
        IERC20 _token = IERC20(token);
        require(_token.balanceOf(msg.sender) >= gain + _debtPayment);

        if (loss > 0) {
            (uint256 _loss, uint256 _debt) = _reportLoss(msg.sender, loss);
            _strategy.totalLoss = _loss;
            _strategy.totalDebt = _debt;
        }
        
        _strategy.totalGain = _strategy.totalGain + gain;
        strategies[msg.sender].totalGain = _strategy.totalGain;
    
        uint256 debt = _debtOutstanding(msg.sender);
        uint256 debtPayment = Math.min(_debtPayment, debt);
    
        if (debtPayment > 0) {
            _strategy.totalDebt = _strategy.totalDebt - debtPayment;
            strategies[msg.sender].totalDebt = _strategy.totalDebt;
            totalDebt -= debtPayment;
            debt -= debtPayment;
        }
        
        uint256 credit = _creditAvailable(msg.sender);
    
        if (credit > 0) {
            _strategy.totalDebt = _strategy.totalDebt + credit;
            strategies[msg.sender].totalDebt = _strategy.totalDebt;
            totalDebt = totalDebt + credit;
        }
    
        uint256 totalAvailable = gain + debtPayment;
        if (totalAvailable < credit) {
            _token.safeTransfer(msg.sender, credit - totalAvailable);
        } else if (totalAvailable > credit) {
            _token.safeTransferFrom(msg.sender, address(this), totalAvailable - credit);
        }
    
        strategies[msg.sender].lastReport = block.timestamp;
        lastReport = block.timestamp;
    
        emit StrategyReported(
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
            return Strategy(msg.sender).estimatedTotalAssets();
        } else {
            return debt;
        }
    }
}
