// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

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
///         attempt to withdraw assets from the underlying strategies. The latter will
///         depend on whether pwrd or gvt is being withdrawn, primary strategy will first be withdrawn from
///         in case of gvt and secondary in case of pwrd, as strategy assets affect system exposure levels.
///         - Withdraw by StrategyOrder/Index:
///             In order to be able to ensure that protocol exposures are within given thresholds
///             inside the vault, the vault can now withdraw from the vault (underlying strategies)
///             by a specific strategy or order of strategies. The orginal yearnV2Vault has a set
///             withdrawalQueue.
///     - The adaptor acts as the first withdraw layer. This means that the adaptor,
///         will always try to maintain a set amount of loose assets to make withdrawals cheaper.
///     - Asset availability:
///         - VaultAdaptor:
///             - vaultReserve (%BP - see BaseVaultAdaptor)
///     - Debt ratios: Ratio in %BP of assets to invest in the underlying strategies of a vault
contract VaultAdaptorMK2 is Controllable, Constants, Whitelist, IVaultMK2 {
    using SafeERC20 for IERC20;

    uint256 public constant MAXIMUM_STRATEGIES = 4;
    address constant ZERO_ADDRESS = address(0);

    // Underlying token
    address public immutable override token;
    uint256 public immutable decimals;
    // Used to establish if the strategy debt ratios need to be updated
    uint256 public StrategyDebtRatioBuffer;
    // How much of total assets should be held in the vault adaptor (%BP)
    uint256 public vaultReserve;
    // Open up the harvest function to the public
    mapping(address => bool) public openHarvest;
    bool public entered;
    uint256 public gasBounty;
    uint256 public baseProfit;

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
    address[MAXIMUM_STRATEGIES] public withdrawalQueue;

    uint256 public debtRatio;
    uint256 public totalDebt;
    uint256 public lastReport;
    uint256 public activation;
    string public name;

    event LogStrategyAdded(
        address indexed strategy,
        uint256 debtRatio,
        uint256 minDebtPerHarvest,
        uint256 maxDebtPerHarvest
    );
    event LogStrategyReported(
        address indexed strategy,
        uint256 gain,
        uint256 loss,
        uint256 debtPaid,
        uint256 totalGain,
        uint256 totalLoss,
        uint256 totalDebt,
        uint256 debtAdded,
        uint256 debtRatio
    );
    event LogUpdateWithdrawalQueue(address[] queue);
    event LogStrategyUpdateDebtRatio(address indexed strategy, uint256 debtRatio);
    event LogStrategyUpdateMinDebtPerHarvest(address indexed strategy, uint256 minDebtPerHarvest);
    event LogStrategyUpdateMaxDebtPerHarvest(address indexed strategy, uint256 maxDebtPerHarvest);
    event LogStrategyMigrated(address indexed newStrategy, address indexed oldStrategy);
    event LogStrategyRevoked(address indexed strategy);
    event LogStrategyRemovedFromQueue(address indexed strategy);
    event LogStrategyAddedToQueue(address indexed strategy);
    event LogStrategyStatusUpdate(address indexed strategy, bool status);

    event LogAdaptorReserve(uint256 reserve);
    event LogBaseProfit(uint256 profit);
    event LogAdaptorStrategyBuffer(uint256 buffer);
    event LogDebtRatios(uint256[] strategyRetios);
    event LogOpenHarvestStatus(address strategy, bool status);
    event LogGasBounty(uint256 amount);
    event LogMigrate(address parent, address child, uint256 amount);
    event LogVaultName(string name);

    constructor(address _token) {
        token = _token;
        name = string(abi.encodePacked(IERC20Detailed(_token).symbol(), " vault"));
        uint256 _decimals = IERC20Detailed(_token).decimals();
        baseProfit = uint256(100) * (uint256(10)**_decimals);
        decimals = _decimals;
    }

    /// @notice Change the name of the vault
    function setName(string calldata _name) external onlyOwner {
        name = _name;
        emit LogVaultName(_name);
    }

    /// @notice How much assets should the vault adapter keep in reserve (%BP)
    function setVaultReserve(uint256 reserve) external onlyOwner {
        require(reserve <= PERCENTAGE_DECIMAL_FACTOR);
        vaultReserve = reserve;
        emit LogAdaptorReserve(reserve);
    }

    /// @notice How much can the utilisation between gvt/pwrd change before updating the debt ratio
    function setStrategyDebtRatioBuffer(uint256 _strategyDebtRatioBuffer) external onlyOwner {
        StrategyDebtRatioBuffer = _strategyDebtRatioBuffer;
        emit LogAdaptorStrategyBuffer(_strategyDebtRatioBuffer);
    }

    /// @notice Is harvest restricted or open for everyone to call
    function setOpenHarvest(address strategy, bool status) external onlyOwner {
        openHarvest[strategy] = status;
        emit LogOpenHarvestStatus(strategy, status);
    }

    /// @notice How much gas rebate does the vault adapter provide (%BP)
    function setGasBounty(uint256 bounty) external onlyOwner {
        gasBounty = bounty;
        emit LogGasBounty(bounty);
    }

    /// @notice Calculate system total assets
    function totalAssets() external view override returns (uint256) {
        return _totalAssets();
    }

    /// @notice Get number of strategies in underlying vault
    function getStrategiesLength() external view override returns (uint256) {
        return strategyLength();
    }

    // All withdraw methods will try to pull assets from the adaptor before moving on
    // to pull assets from underlying strategies

    /// @notice Withdraw assets from vault
    /// @param amount Amount to withdraw
    /// @dev Entry point for lifeguard
    function withdraw(uint256 amount) external override {
        require(msg.sender == ctrl().lifeGuard(), "withdraw: !lifeguard");
        _withdraw(0, amount, msg.sender, 1);
    }

    /// @notice Withdraw assets from vault
    /// @param amount Amount to withdraw
    /// @param recipient Target recipient
    /// @dev Entry point for insurance
    function withdraw(uint256 amount, address recipient) external override {
        require(msg.sender == ctrl().insurance(), "withdraw: !insurance");
        _withdraw(0, amount, recipient, 1);
    }

    /// @notice Withdraw assets from strategies to vault adapter
    /// @param amount Amount to withdraw
    /// @param maxLoss Maximum amount of loss tolerated when pulling assets from strategies
    /// @dev Usefull for topping up vault adapters reserves if needed without having to call harvest
    function withdrawToAdapter(uint256 amount, uint256 maxLoss) external onlyWhitelist {
        _withdraw(0, amount, address(this), maxLoss);
    }

    /// @notice Withdraw assets from vault adapter, if withdrawal pulls from strategies, do so
    ///     in a specific order as we want to maintain protocol exposure depending on if pwrd/gvt
    /// @notice Withdraw assets from underlying vault, but do so in a specific strategy order
    /// @param amount Amount to withdraw
    /// @param recipient Target recipient
    /// @dev This is an addaptation for yearn v2 vaults - these vaults have a defined withdraw
    ///     order. Gro protocol needs to respect prtocol exposure, and thus might have to withdraw
    ///     from different strategies depending on if pwrd or gvts are withdrawn.
    function withdrawByStrategyOrder(
        uint256 amount,
        address recipient,
        bool reversed
    ) external override returns (uint256) {
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
        return _withdraw(strategyIndex, amount, recipient, 1);
    }

    /// @notice Withdraw assets from vault adapter, if assets need do be withdrawn from the underlying strategy
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
    ) external override returns (uint256) {
        require(msg.sender == ctrl().insurance(), "withdraw: !insurance");
        return _withdraw(strategyIndex, amount, recipient, 1);
    }

    /// @notice Get total amount invested in strategy
    /// @param index Index of strategy
    function getStrategyAssets(uint256 index) external view override returns (uint256 amount) {
        return _getStrategyTotalAssets(index);
    }

    /// @notice Deposit assets into the vault adaptor
    /// @param amount Deposit amount
    function deposit(uint256 amount) external override {
        require(msg.sender == ctrl().lifeGuard(), "deposit: !lifeguard");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Check if underlying strategy needs to be harvested
    /// @param index Index of stratey
    /// @param callCost Cost of harvest in underlying token
    function strategyHarvestTrigger(uint256 index, uint256 callCost) external view override returns (bool harvested) {
        require(index < strategyLength(), "invalid index");
        return _strategyHarvestTrigger(index, callCost);
    }

    /// @notice Harvest underlying strategy
    /// @param index Index of strategy
    /// @dev Any Gains/Losses incurred by harvesting a streategy is accounted for in the vault adapter
    ///     and reported back to the Controller, which in turn updates current system total assets
    function strategyHarvest(uint256 index) external override returns (bool harvested) {
        require(!entered, "Harvest already running");
        require(index < strategyLength(), "invalid index");
        entered = true;
        uint256 beforeAssets = _totalAssets();
        _strategyHarvest(index);
        uint256 afterAssets = _totalAssets();
        if (afterAssets > beforeAssets) {
            if (gasBounty > 0) {
                // Pass on a proportion of the profit to the user who called the harvest
                uint256 profit = afterAssets - beforeAssets;
                if (profit > baseProfit) {
                    uint256 reward = (profit * gasBounty) / 10000;
                    afterAssets -= reward;
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
        address _token = token;
        require(IVaultMK2(child).token() == _token, "migrate: incorrect vault token");
        uint256 balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(child, balance);
        emit LogMigrate(address(this), child, balance);
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
        require(queue.length <= MAXIMUM_STRATEGIES, "setWithdrawalQueue: > MAXIMUM_STRATEGIES");
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (i >= queue.length) {
                withdrawalQueue[i] = address(0);
            } else {
                withdrawalQueue[i] = queue[i];
            }
            emit LogUpdateWithdrawalQueue(queue);
        }
    }

    /// @notice Number of active strategies in the vaultAdapter
    function strategyLength() internal view returns (uint256) {
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == address(0)) {
                return i;
            }
        }
        return MAXIMUM_STRATEGIES;
    }

    /// @notice Check if the vaults debt ratios need to be updated - This depends on the current utilisation ratio
    ///     of pwrd/gvt
    function updateStrategyDebtRatioTrigger() public view returns (bool, uint256[] memory) {
        uint256 _strategyLength = strategyLength();
        require(_strategyLength > 1, "updateStrategyDebtRatioTrigger: !strategyLength");
        uint256[] memory targetRatios = ctrl().getStrategiesTargetRatio();
        uint256[] memory currentRatios = _getStrategiesDebtRatio();
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

    /// @notice Update the strategy debt ratios of the vault based on current utilisation ratio
    function updateStrategyDebtRatio() external {
        (bool update, uint256[] memory ratios) = updateStrategyDebtRatioTrigger();
        if (update) {
            require(update, "updateStrategyDebtRatio: !update");
            setStrategyDebtRatio(ratios);
        }
    }

    /// @notice Update the debtRatio of a specific strategy
    /// @param strategy Target strategy
    /// @param _debtRatio new debt ratio
    function updateStrategyDebtRatio(address strategy, uint256 _debtRatio) external override {
        // If a strategy isnt the source of the call
        if (!strategies[msg.sender].active) {
            require(msg.sender == owner() || whitelist[msg.sender], "updateStrategyDebtRatio: !whitelist");
        }
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, "updateStrategyDebtRatio: debtRatio > 100%");
        emit LogStrategyUpdateDebtRatio(strategy, _debtRatio);
    }

    /// @notice Set new strategy debt ratios
    /// @param StrategyDebtRatios Array of new debt ratios
    /// @dev Can be used to forecfully change the debt ratios of the underlying strategies
    ///     by whitelisted parties/owner
    function setStrategyDebtRatio(uint256[] memory StrategyDebtRatios) public override {
        require(
            msg.sender == ctrl().insurance() || msg.sender == owner() || whitelist[msg.sender],
            "!setStrategyDebtRatio: !approved|insurance"
        );
        require(StrategyDebtRatios.length <= MAXIMUM_STRATEGIES, "setStrategyDebtRatio: > MAXIMUM_STRATEGIES");
        address _strategy;
        uint256 _ratio;
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            _strategy = withdrawalQueue[i];
            if (_strategy == address(0)) {
                break;
            } else {
                _ratio = StrategyDebtRatios[i];
            }
            _setStrategyDebtRatio(_strategy, _ratio);
        }
        require(debtRatio <= PERCENTAGE_DECIMAL_FACTOR, "updateStrategyDebtRatio: debtRatio > 100%");
    }

    /// @notice Add a new strategy to the vault adapter
    /// @param strategy Target strategy to add
    /// @param _debtRatio Target debtRatio of strategy
    /// @param minDebtPerHarvest Min amount of debt the strategy can take on per harvest
    /// @param maxDebtPerHarvest Max amount of debt the strategy can take on per harvest
    function addStrategy(
        address strategy,
        uint256 _debtRatio,
        uint256 minDebtPerHarvest,
        uint256 maxDebtPerHarvest
    ) external onlyOwner {
        require(withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS, "addStrategy: > MAXIMUM_STRATEGIES");
        require(strategy != ZERO_ADDRESS, "addStrategy: address(0x)");
        require(!strategies[strategy].active, "addStrategy: !activated");
        require(address(this) == Strategy(strategy).vault(), "addStrategy: !vault");
        require(token == Strategy(strategy).want(), "addStrategy: !want");
        require(debtRatio + _debtRatio <= PERCENTAGE_DECIMAL_FACTOR, "addStrategy: debtRatio > 100%");
        require(minDebtPerHarvest <= maxDebtPerHarvest, "addStrategy: min > max");

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
        require(strategies[strategy].activation > 0, "updateStrategyMinDebtPerHarvest: !activated");
        require(
            strategies[strategy].maxDebtPerHarvest >= minDebtPerHarvest,
            "updateStrategyMinDebtPerHarvest: min > max"
        );

        strategies[strategy].minDebtPerHarvest = minDebtPerHarvest;
        emit LogStrategyUpdateMinDebtPerHarvest(strategy, minDebtPerHarvest);
    }

    function updateStrategyMaxDebtPerHarvest(address strategy, uint256 maxDebtPerHarvest) external onlyOwner {
        require(strategies[strategy].activation > 0, "updateStrategyMaxDebtPerHarvest: !activated");
        require(
            strategies[strategy].minDebtPerHarvest <= maxDebtPerHarvest,
            "updateStrategyMaxDebtPerHarvest: min > max"
        );

        strategies[strategy].maxDebtPerHarvest = maxDebtPerHarvest;
        emit LogStrategyUpdateMaxDebtPerHarvest(strategy, maxDebtPerHarvest);
    }

    /// @notice Replace existing strategy with a new one, removing he old one from the vault adapters
    ///     active strategies
    /// @param oldVersion address of old strategy
    /// @param newVersion address of new strategy
    function migrateStrategy(address oldVersion, address newVersion) external onlyOwner {
        require(newVersion != ZERO_ADDRESS, "migrateStrategy: 0x");
        require(strategies[oldVersion].activation > 0, "migrateStrategy: oldVersion !activated");
        require(strategies[newVersion].activation == 0, "migrateStrategy: newVersion activated");

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

        Strategy(oldVersion).migrate(newVersion);

        _strategy.totalDebt = 0;
        _strategy.minDebtPerHarvest = 0;
        _strategy.maxDebtPerHarvest = 0;

        emit LogStrategyMigrated(oldVersion, newVersion);

        _revokeStrategy(oldVersion);

        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == oldVersion) {
                withdrawalQueue[i] = newVersion;
                return;
            }
        }
    }

    /// @notice Remove strategy from vault adapter, called by strategy on emergencyExit
    function revokeStrategy() external {
        require(strategies[msg.sender].active, "revokeStrategy: strategy not active");
        _revokeStrategy(msg.sender);
    }

    /// @notice Manually add a strategy to the withdrawal queue
    /// @param strategy Target strategy to add
    function addStrategyToQueue(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender], "addStrategyToQueue: !owner|whitelist");
        require(strategies[strategy].activation > 0, "addStrategyToQueue: !activated");
        require(withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS, "addStrategyToQueue: queue full");
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            address _strategy = withdrawalQueue[i];
            if (_strategy == ZERO_ADDRESS) break;
            require(_strategy != strategy, "addStrategyToQueue: strategy already in queue");
        }
        withdrawalQueue[MAXIMUM_STRATEGIES - 1] = strategy;
        _organizeWithdrawalQueue();
        emit LogStrategyAddedToQueue(strategy);
    }

    /// @notice Manually remove a strategy to the withdrawal queue
    /// @param strategy Target strategy to remove
    function removeStrategyFromQueue(address strategy) external {
        require(msg.sender == owner() || whitelist[msg.sender], "removeStrategyFromQueue: !owner|whitelist");
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

    /// @notice Strategy Expected returns based on previous returns/harvests
    /// @param strategy Target strategy
    function expectedReturn(address strategy) external view returns (uint256) {
        return _expectedReturn(strategy);
    }

    /// @notice Calculate the amount of assets the vault has available for the strategy to pull and invest,
    ///     the available credit is based of the strategies debt ratio and the total available assets (total assets - reserves)
    ///     the vault has
    /// @param strategy Target strategy
    /// @dev Called during harvest
    function _creditAvailable(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 vault_totalAssets = _totalAssetsAvailable();
        uint256 vault_debtLimit = (debtRatio * vault_totalAssets) / PERCENTAGE_DECIMAL_FACTOR;
        uint256 vault_totalDebt = totalDebt;
        uint256 strategy_debtLimit = (_strategyData.debtRatio * vault_totalAssets) / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategy_totalDebt = _strategyData.totalDebt;
        uint256 strategy_minDebtPerHarvest = _strategyData.minDebtPerHarvest;
        uint256 strategy_maxDebtPerHarvest = _strategyData.maxDebtPerHarvest;

        IERC20 _token = IERC20(token);

        if (strategy_debtLimit <= strategy_totalDebt || vault_debtLimit <= vault_totalDebt) {
            return 0;
        }

        uint256 available = strategy_debtLimit - strategy_totalDebt;

        available = Math.min(available, vault_debtLimit - vault_totalDebt);

        available = Math.min(available, _token.balanceOf(address(this)));

        if (available < strategy_minDebtPerHarvest) {
            return 0;
        } else {
            return Math.min(available, strategy_maxDebtPerHarvest);
        }
    }

    /// @notice strategy expected returns, used to give an estimate of how much yield the
    ///     strategy has accrued, preferably a strategy should supply this function, but in
    ///     lieue of that, the vault adapter can be used to approximate returns.
    /// @param strategy Target strategy
    function _expectedReturn(address strategy) internal view returns (uint256) {
        StrategyParams memory _strategyData = strategies[strategy];
        uint256 strategy_lastReport = _strategyData.lastReport;
        uint256 timeSinceLastHarvest = block.timestamp - strategy_lastReport;
        uint256 totalHarvestTime = strategy_lastReport - _strategyData.activation;

        if (timeSinceLastHarvest > 0 && totalHarvestTime > 0 && Strategy(strategy).isActive()) {
            return (_strategyData.totalGain * timeSinceLastHarvest) / totalHarvestTime;
        } else {
            return 0;
        }
    }

    /// @notice Deal with any loss that a strategy has realized
    /// @param strategy target strategy
    /// @param loss amount of loss realized
    function _reportLoss(address strategy, uint256 loss) internal {
        StrategyParams storage _strategy = strategies[strategy];
        // Loss can only be up the amount of debt issued to strategy
        require(_strategy.totalDebt >= loss, "_reportLoss: totalDebt >= loss");
        // Add loss to srategy and remove loss from strategyDebt
        _strategy.totalLoss += loss;
        _strategy.totalDebt -= loss;
        totalDebt -= loss;
    }

    /// @notice Amount by which a strategy exceeds its current debt limit
    /// @param strategy target strategy
    function _debtOutstanding(address strategy) internal view returns (uint256) {
        StrategyParams storage _strategy = strategies[strategy];
        uint256 strategy_debtLimit = (_strategy.debtRatio * _totalAssetsAvailable()) / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategy_totalDebt = _strategy.totalDebt;

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

    /// @notice Remove unwanted token from contract
    /// @param _token Address of unwanted token, cannot be want token
    /// @param recipient Reciever of unwanted token
    function sweep(address _token, address recipient) external onlyOwner {
        require(_token != token, "sweep: token == want");
        uint256 amount = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(recipient, amount);
    }

    /// @notice Withdraw desired amount from vault adapter, if the reserves are unable to
    ///     to cover the desired amount, start withdrawing from strategies in order specified
    /// @param index Index of strategy withdrawal, dictates order of withdrawal
    /// @param _amount Amount to withdraw
    /// @param recipient Recipient for withdrawal
    /// @param maxLoss Max accepted loss when withdrawing from strategy
    function _withdraw(
        uint256 index,
        uint256 _amount,
        address recipient,
        uint256 maxLoss
    ) internal returns (uint256) {
        address[MAXIMUM_STRATEGIES] memory _strategies;
        address[MAXIMUM_STRATEGIES] memory _withdrawalQueue = withdrawalQueue;
        uint256 _strategyLength = strategyLength();
        uint256 value = _amount;

        IERC20 _token = IERC20(token);
        if (index == 0) {
            // Withdraw by std withdrawal queue order Primary => Secondary
            _strategies = _withdrawalQueue;
        } else if (index == MAXIMUM_STRATEGIES) {
            // Withdraw by reverse withdrawal queue order Secondary => primary
            for (uint256 i = _strategyLength; i > 0; i--) {
                _strategies[i - 1] = _withdrawalQueue[(_strategyLength - i)];
            }
        } else {
            // Withdraw from a specific strategy
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
        // If reserves dont cover the withdrawal, start withdrawing from strategies
        if (value > _token.balanceOf(address(this))) {
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

                uint256 loss = Strategy(_strategy).withdraw(amountNeeded);
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
        }
        uint256 finalBalance = _token.balanceOf(address(this));
        // If we dont have enough assets to cover the withdrawal, lower it
        //      to what we have, this should technically never happen
        if (value > finalBalance) {
            value = finalBalance;
        }

        require(totalLoss <= (maxLoss * (value + totalLoss)) / PERCENTAGE_DECIMAL_FACTOR);

        _token.safeTransfer(recipient, value);
        return value;
    }

    /// @notice Report back any gains/losses from a (strategy) harvest, vault adapetr
    ///     calls back debt or gives out more credit to the strategy depending on available
    ///     credit and the strategies current position.
    /// @param gain Strategy gains from latest harvest
    /// @param loss Strategy losses from latest harvest
    /// @param _debtPayment Amount strategy can pay back to vault
    function report(
        uint256 gain,
        uint256 loss,
        uint256 _debtPayment
    ) external returns (uint256) {
        StrategyParams storage _strategy = strategies[msg.sender];
        require(_strategy.active, "report: !activated");
        IERC20 _token = IERC20(token);
        require(_token.balanceOf(msg.sender) >= gain + _debtPayment);

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
            return Strategy(msg.sender).estimatedTotalAssets();
        } else {
            return debt;
        }
    }

    function _strategyHarvest(uint256 index) internal {
        address _strategy = withdrawalQueue[index];
        if (!openHarvest[_strategy]) {
            require(whitelist[msg.sender], "StrategyHarvest: !whitelist");
        }
        Strategy(_strategy).harvest();
    }

    function _setStrategyDebtRatio(address strategy, uint256 _debtRatio) internal {
        require(strategies[strategy].activation > 0, "_setStrategyDebtRatio: !activated");
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        emit LogStrategyUpdateDebtRatio(strategy, _debtRatio);
    }

    /// @notice Return debt ratio of underlying strategies
    function _getStrategiesDebtRatio() internal view returns (uint256[] memory ratios) {
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

    function _getStrategyEstimatedTotalAssets(uint256 index) internal view returns (uint256) {
        return Strategy(withdrawalQueue[index]).estimatedTotalAssets();
    }

    function _getStrategyTotalAssets(uint256 index) internal view returns (uint256) {
        StrategyParams storage strategy = strategies[withdrawalQueue[index]];
        return strategy.totalDebt;
    }

    function _revokeStrategy(address strategy) internal {
        debtRatio -= strategies[strategy].debtRatio;
        strategies[strategy].debtRatio = 0;
        strategies[strategy].active = false;
        emit LogStrategyRevoked(strategy);
    }

    function _totalAssets() private view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) + totalDebt;
    }

    function _totalAssetsAvailable() private view returns (uint256) {
        return (_totalAssets() * (PERCENTAGE_DECIMAL_FACTOR - vaultReserve)) / PERCENTAGE_DECIMAL_FACTOR;
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
