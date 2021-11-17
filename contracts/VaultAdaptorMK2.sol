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

    function ammCheck(uint256 _check, uint256 _minAmount)
        external
        view
        returns (bool);
}

/// @notice VaultAdapterMk2 - Gro protocol stand alone vault for strategy testing
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
///         - VaultAdaptor
///         - Strategies
///     - Debt ratios: Ratio in %BP of assets to invest in the underlying strategies of a vault
contract VaultAdaptorMK2 is
    Constants,
    Whitelist,
    IVaultMK2,
    ERC20,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    uint256 public constant MAXIMUM_STRATEGIES = 5;
    address constant ZERO_ADDRESS = address(0);

    // Underlying token
    address public immutable override token;
    uint256 private immutable _decimals;

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
    address public rewards;
    uint256 public vaultFee;

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
    event LogNewDebtRatio(address indexed strategy, uint256 debtRatio);
    event LogStrategyUpdateMinDebtPerHarvest(
        address indexed strategy,
        uint256 minDebtPerHarvest
    );
    event LogStrategyUpdateMaxDebtPerHarvest(
        address indexed strategy,
        uint256 maxDebtPerHarvest
    );
    event LogStrategyMigrated(
        address indexed newStrategy,
        address indexed oldStrategy
    );
    event LogStrategyRevoked(address indexed strategy);
    event LogStrategyRemovedFromQueue(address indexed strategy);
    event LogStrategyAddedToQueue(address indexed strategy);
    event LogStrategyStatusUpdate(address indexed strategy, bool status);

    event LogDepositLimit(uint256 newLimit);
    event LogDebtRatios(uint256[] strategyRetios);
    event LogMigrate(address parent, address child, uint256 amount);
    event LogNewBouncer(address bouncer);
    event LogNewRewards(address rewards);
    event LogNewVaultFee(uint256 vaultFee);
    event LogNewStrategyHarvest(bool loss, uint256 change);
    event LogNewAllowance(address user, uint256 amount);
    event LogDeposit(
        address indexed from,
        uint256 _amount,
        uint256 shares,
        uint256 allowance
    );
    event LogWithdrawal(
        address indexed from,
        uint256 value,
        uint256 shares,
        uint256 totalLoss,
        uint256 allowance
    );

    constructor(address _token, address _bouncer)
        ERC20(
            string(abi.encodePacked("Gro ", IERC20Detailed(_token).symbol(), " Lab")),
            string(abi.encodePacked("gro", IERC20Detailed(_token).symbol()))
        )
    {
        token = _token;
        activation = block.timestamp;
        _decimals = IERC20Detailed(_token).decimals();
        bouncer = _bouncer;
    }

    /// @notice Vault share decimals
    function decimals() public view override returns (uint8) {
        return uint8(_decimals);
    }

    /// @notice Set contract that controlls user allowance
    /// @param _bouncer address of new bouncer
    function setBouncer(address _bouncer) external onlyOwner {
        bouncer = _bouncer;
        emit LogNewBouncer(_bouncer);
    }

    /// @notice Set contract that will recieve vault fees
    /// @param _rewards address of rewards contract
    function setRewards(address _rewards) external onlyOwner {
        rewards = _rewards;
        emit LogNewRewards(_rewards);
    }

    /// @notice Set fee that is reduced from strategy yields when harvests are called
    /// @param _fee new strategy fee
    function setVaultFee(uint256 _fee) external onlyOwner {
        require(_fee < 3000, "setVaultFee: _fee > 30%");
        vaultFee = _fee;
        emit LogNewVaultFee(_fee);
    }

    /// @notice Total limit for vault deposits
    /// @param _newLimit new max deposit limit for the vault
    function setDepositLimit(uint256 _newLimit) external onlyOwner {
        depositLimit = _newLimit;
        emit LogDepositLimit(_newLimit);
    }

    /// @notice Limit for how much individual users are allowed to deposit
    /// @param _user user to set allowance for
    /// @param _amount new allowance amount
    function setUserAllowance(address _user, uint256 _amount) external {
        require(
            msg.sender == bouncer,
            "setUserAllowance: msg.sender != bouncer"
        );
        userAllowance[_user] += _amount * (10**_decimals);
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
    /// @param _index index of strategy
    function getStrategyAssets(uint256 _index)
        external
        view
        override
        returns (uint256 amount)
    {
        return _getStrategyTotalAssets(_index);
    }

    /// @notice Deposit assets into the vault adaptor
    /// @param _amount user deposit amount
    function deposit(uint256 _amount) external nonReentrant returns (uint256) {
        require(_amount > 0, "deposit: _amount !> 0");
        require(
            _totalAssets() + _amount <= depositLimit,
            "deposit: !depositLimit"
        );
        require(
            userAllowance[msg.sender] >= _amount,
            "deposit: !userAllowance"
        );

        uint256 shares = _issueSharesForAmount(msg.sender, _amount);

        IERC20 _token = IERC20(token);
        _token.safeTransferFrom(msg.sender, address(this), _amount);

        uint256 _allowance = userAllowance[msg.sender] - _amount;
        userAllowance[msg.sender] = _allowance;
        emit LogDeposit(msg.sender, _amount, shares, _allowance);
        return shares;
    }

    /// @notice Mint shares for user based on deposit amount
    /// @param _to recipient
    /// @param _amount amount of want deposited
    function _issueSharesForAmount(address _to, uint256 _amount)
        internal
        returns (uint256)
    {
        uint256 shares = 0;
        uint256 _totalSupply = totalSupply();
        if (_totalSupply > 0) {
            shares = (_amount * _totalSupply) / _totalAssets();
        } else {
            shares = _amount;
        }
        // unlikely to happen, just here for added safety
        require(shares != 0, "_issueSharesForAmount: shares == 0");
        _mint(_to, shares);

        return shares;
    }

    /// @notice Check if underlying strategy needs to be harvested
    /// @param _index Index of stratey
    /// @param _callCost Cost of harvest in underlying token
    function strategyHarvestTrigger(uint256 _index, uint256 _callCost)
        external
        view
        override
        returns (bool)
    {
        require(_index < strategyLength(), "invalid index");
        return IStrategy(withdrawalQueue[_index]).harvestTrigger(_callCost);
    }

    /// @notice Harvest underlying strategy
    /// @param _index Index of strategy
    /// @param _check Amount to check against AMM if applicable
    /// @param _minAmount minAmount to expect to get out of AMM
    /// @dev Any Gains/Losses incurred by harvesting a streategy is accounted for in the vault adapter
    ///     and reported back to the Controller, which in turn updates current system total assets.
    ///     AMM checks are used as external verifications to avoid sandwich attacks when interacting with
    ///     with strategies (priceing and swapping).
    function strategyHarvest(
        uint256 _index,
        uint256 _check,
        uint256 _minAmount
    ) external nonReentrant onlyWhitelist {
        require(_index < strategyLength(), "invalid index");
        IStrategy _strategy = IStrategy(withdrawalQueue[_index]);
        uint256 beforeAssets = _totalAssets();
        if (_check > 0) {
            require(
                _strategy.ammCheck(_check, _minAmount),
                "strategyHarvest: !ammCheck"
            );
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
    /// @param _queue New withdrawal queue order
    function setWithdrawalQueue(address[] calldata _queue) external onlyOwner {
        require(
            _queue.length <= MAXIMUM_STRATEGIES,
            "setWithdrawalQueue: > MAXIMUM_STRATEGIES"
        );
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (i >= _queue.length) {
                withdrawalQueue[i] = address(0);
            } else {
                withdrawalQueue[i] = _queue[i];
            }
            emit LogUpdateWithdrawalQueue(_queue);
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

    /// @notice Update the debtRatio of a specific strategy
    /// @param _strategy target strategy
    /// @param _debtRatio new debt ratio
    function setDebtRatio(address _strategy, uint256 _debtRatio) external {
        // If a strategy isnt the source of the call
        require(strategies[_strategy].active, "setDebtRatio: !active");
        require(
            msg.sender == owner() || whitelist[msg.sender],
            "setDebtRatio: !whitelist"
        );
        _setDebtRatio(_strategy, _debtRatio);
        require(
            debtRatio <= PERCENTAGE_DECIMAL_FACTOR,
            "setDebtRatio: debtRatio > 100%"
        );
    }

    /// @notice Set new strategy debt ratios
    /// @param _strategyDebtRatios array of new debt ratios
    /// @dev Can be used to forecfully change the debt ratios of the underlying strategies
    ///     by whitelisted parties/owner
    function setDebtRatios(uint256[] memory _strategyDebtRatios) external {
        require(
            msg.sender == owner() || whitelist[msg.sender],
            "setDebtRatios: !whitelist"
        );
        require(
            _strategyDebtRatios.length <= MAXIMUM_STRATEGIES,
            "setDebtRatios: > MAXIMUM_STRATEGIES"
        );
        address _strategy;
        uint256 _ratio;
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            _strategy = withdrawalQueue[i];
            if (_strategy == address(0)) {
                break;
            } else {
                _ratio = _strategyDebtRatios[i];
            }
            _setDebtRatio(_strategy, _ratio);
        }
        require(
            debtRatio <= PERCENTAGE_DECIMAL_FACTOR,
            "setDebtRatios: debtRatio > 100%"
        );
    }

    /// @notice Add a new strategy to the vault adapter
    /// @param _strategy target strategy to add
    /// @param _debtRatio target debtRatio of strategy
    /// @param _minDebtPerHarvest min amount of debt the strategy can take on per harvest
    /// @param _maxDebtPerHarvest max amount of debt the strategy can take on per harvest
    function addStrategy(
        address _strategy,
        uint256 _debtRatio,
        uint256 _minDebtPerHarvest,
        uint256 _maxDebtPerHarvest
    ) external onlyOwner {
        require(
            withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS,
            "addStrategy: > MAXIMUM_STRATEGIES"
        );
        require(_strategy != ZERO_ADDRESS, "addStrategy: address(0x)");
        require(!strategies[_strategy].active, "addStrategy: !activated");
        require(
            address(this) == IStrategy(_strategy).vault(),
            "addStrategy: !vault"
        );
        require(
            debtRatio + _debtRatio <= PERCENTAGE_DECIMAL_FACTOR,
            "addStrategy: debtRatio > 100%"
        );
        require(
            _minDebtPerHarvest <= _maxDebtPerHarvest,
            "addStrategy: min > max"
        );

        StrategyParams storage newStrat = strategies[_strategy];
        newStrat.activation = block.timestamp;
        newStrat.active = true;
        newStrat.debtRatio = _debtRatio;
        newStrat.minDebtPerHarvest = _minDebtPerHarvest;
        newStrat.maxDebtPerHarvest = _maxDebtPerHarvest;
        newStrat.lastReport = block.timestamp;

        emit LogStrategyAdded(
            _strategy,
            _debtRatio,
            _minDebtPerHarvest,
            _maxDebtPerHarvest
        );

        debtRatio += _debtRatio;

        withdrawalQueue[strategyLength()] = _strategy;
        _organizeWithdrawalQueue();
    }

    /// @notice Set a new min debt equired for assets to be made available to the strategy at harvest
    /// @param _strategy strategy address
    /// @param _minDebtPerHarvest new min debt
    function updateStrategyMinDebtPerHarvest(
        address _strategy,
        uint256 _minDebtPerHarvest
    ) external onlyOwner {
        require(
            strategies[_strategy].activation > 0,
            "updateStrategyMinDebtPerHarvest: !activated"
        );
        require(
            strategies[_strategy].maxDebtPerHarvest >= _minDebtPerHarvest,
            "updateStrategyMinDebtPerHarvest: min > max"
        );

        strategies[_strategy].minDebtPerHarvest = _minDebtPerHarvest;
        emit LogStrategyUpdateMinDebtPerHarvest(_strategy, _minDebtPerHarvest);
    }

    /// @notice Set a new max debt that can be made avilable to the stragey at harvest
    /// @param _strategy strategy address
    /// @param _maxDebtPerHarvest new max debt
    function updateStrategyMaxDebtPerHarvest(
        address _strategy,
        uint256 _maxDebtPerHarvest
    ) external onlyOwner {
        require(
            strategies[_strategy].activation > 0,
            "updateStrategyMaxDebtPerHarvest: !activated"
        );
        require(
            strategies[_strategy].minDebtPerHarvest <= _maxDebtPerHarvest,
            "updateStrategyMaxDebtPerHarvest: min > max"
        );

        strategies[_strategy].maxDebtPerHarvest = _maxDebtPerHarvest;
        emit LogStrategyUpdateMaxDebtPerHarvest(_strategy, _maxDebtPerHarvest);
    }

    /// @notice Replace existing strategy with a new one, removing he old one from the vault adapters
    ///     active strategies
    /// @param _oldVersion address of old strategy
    /// @param _newVersion address of new strategy
    function migrateStrategy(address _oldVersion, address _newVersion)
        external
        onlyOwner
    {
        require(_newVersion != ZERO_ADDRESS, "migrateStrategy: 0x");
        require(
            strategies[_oldVersion].activation > 0,
            "migrateStrategy: oldVersion !activated"
        );
        require(
            strategies[_oldVersion].active,
            "migrateStrategy: oldVersion !active"
        );
        require(
            strategies[_newVersion].activation == 0,
            "migrateStrategy: newVersion activated"
        );

        StrategyParams storage _strategy = strategies[_oldVersion];

        debtRatio += _strategy.debtRatio;

        StrategyParams storage newStrat = strategies[_newVersion];
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

        IStrategy(_oldVersion).migrate(_newVersion);

        _strategy.totalDebt = 0;
        _strategy.minDebtPerHarvest = 0;
        _strategy.maxDebtPerHarvest = 0;

        emit LogStrategyMigrated(_oldVersion, _newVersion);

        _revokeStrategy(_oldVersion);

        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == _oldVersion) {
                withdrawalQueue[i] = _newVersion;
                return;
            }
        }
    }

    /// @notice Remove strategy from vault adapter, called by strategy on emergencyExit
    function revokeStrategy() external {
        require(
            strategies[msg.sender].active,
            "revokeStrategy: strategy not active"
        );
        _revokeStrategy(msg.sender);
    }

    /// @notice Manually add a strategy to the withdrawal queue
    /// @param _strategy target strategy to add
    function addStrategyToQueue(address _strategy) external {
        require(
            msg.sender == owner() || whitelist[msg.sender],
            "addStrategyToQueue: !owner|whitelist"
        );
        require(
            strategies[_strategy].activation > 0,
            "addStrategyToQueue: !activated"
        );
        require(
            withdrawalQueue[MAXIMUM_STRATEGIES - 1] == ZERO_ADDRESS,
            "addStrategyToQueue: queue full"
        );
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            address strategy = withdrawalQueue[i];
            if (strategy == ZERO_ADDRESS) break;
            require(
                _strategy != strategy,
                "addStrategyToQueue: strategy already in queue"
            );
        }
        withdrawalQueue[MAXIMUM_STRATEGIES - 1] = _strategy;
        _organizeWithdrawalQueue();
        emit LogStrategyAddedToQueue(_strategy);
    }

    /// @notice Manually remove a strategy to the withdrawal queue
    /// @param _strategy Target strategy to remove
    function removeStrategyFromQueue(address _strategy) external {
        require(
            msg.sender == owner() || whitelist[msg.sender],
            "removeStrategyFromQueue: !owner|whitelist"
        );
        for (uint256 i; i < MAXIMUM_STRATEGIES; i++) {
            if (withdrawalQueue[i] == _strategy) {
                withdrawalQueue[i] = ZERO_ADDRESS;
                _organizeWithdrawalQueue();
                emit LogStrategyRemovedFromQueue(_strategy);
                return;
            }
        }
    }

    /// @notice Check how much credits are available for the strategy
    /// @param _strategy Target strategy
    function creditAvailable(address _strategy)
        external
        view
        returns (uint256)
    {
        return _creditAvailable(_strategy);
    }

    /// @notice Same as above but called by the streategy
    function creditAvailable() external view returns (uint256) {
        return _creditAvailable(msg.sender);
    }

    /// @notice Calculate the amount of assets the vault has available for the strategy to pull and invest,
    ///     the available credit is based of the strategies debt ratio and the total available assets
    ///     the vault has
    /// @param _strategy target strategy
    /// @dev called during harvest
    function _creditAvailable(address _strategy)
        internal
        view
        returns (uint256)
    {
        StrategyParams memory _strategyData = strategies[_strategy];
        uint256 vaultTotalAssets = _totalAssets();
        uint256 vaultDebtLimit = (debtRatio * vaultTotalAssets) /
            PERCENTAGE_DECIMAL_FACTOR;
        uint256 vaultTotalDebt = totalDebt;
        uint256 strategyDebtLimit = (_strategyData.debtRatio *
            vaultTotalAssets) / PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategyTotalDebt = _strategyData.totalDebt;
        uint256 strategyMinDebtPerHarvest = _strategyData.minDebtPerHarvest;
        uint256 strategyMaxDebtPerHarvest = _strategyData.maxDebtPerHarvest;

        IERC20 _token = IERC20(token);

        if (
            strategyDebtLimit <= strategyTotalDebt ||
            vaultDebtLimit <= vaultTotalDebt
        ) {
            return 0;
        }

        uint256 available = strategyDebtLimit - strategyTotalDebt;

        available = Math.min(available, vaultDebtLimit - vaultTotalDebt);

        available = Math.min(available, _token.balanceOf(address(this)));

        if (available < strategyMinDebtPerHarvest) {
            return 0;
        } else {
            return Math.min(available, strategyMaxDebtPerHarvest);
        }
    }

    /// @notice Deal with any loss that a strategy has realized
    /// @param _strategy target strategy
    /// @param _loss amount of loss realized
    function _reportLoss(address _strategy, uint256 _loss) internal {
        StrategyParams storage strategy = strategies[_strategy];
        // Loss can only be up the amount of debt issued to strategy
        require(strategy.totalDebt >= _loss, "_reportLoss: totalDebt >= loss");
        // Add loss to srategy and remove loss from strategyDebt
        strategy.totalLoss += _loss;
        strategy.totalDebt -= _loss;
        totalDebt -= _loss;
    }

    /// @notice Amount by which a strategy exceeds its current debt limit
    /// @param _strategy target strategy
    function _debtOutstanding(address _strategy)
        internal
        view
        returns (uint256)
    {
        StrategyParams storage strategy = strategies[_strategy];
        uint256 strategyDebtLimit = (strategy.debtRatio * _totalAssets()) /
            PERCENTAGE_DECIMAL_FACTOR;
        uint256 strategyTotalDebt = strategy.totalDebt;

        if (strategyTotalDebt <= strategyDebtLimit) {
            return 0;
        } else {
            return strategyTotalDebt - strategyDebtLimit;
        }
    }

    /// @notice Amount of debt the strategy has to pay back to the vault at next harvest
    /// @param _strategy target strategy
    function debtOutstanding(address _strategy)
        external
        view
        returns (uint256)
    {
        return _debtOutstanding(_strategy);
    }

    /// @notice Amount of debt the strategy has to pay back to the vault at next harvest
    /// @dev same as above but used by strategies
    function debtOutstanding() external view returns (uint256) {
        return _debtOutstanding(msg.sender);
    }

    /// @notice A strategies total debt to the vault
    /// @dev here to simplify strategies life when trying to get the totalDebt
    function strategyDebt() external view returns (uint256) {
        return strategies[msg.sender].totalDebt;
    }

    /// @notice Remove unwanted token from contract
    /// @param _token Address of unwanted token, cannot be want token
    /// @param _recipient Reciever of unwanted token
    function sweep(address _token, address _recipient) external onlyOwner {
        require(_token != token, "sweep: token == want");
        uint256 amount = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(_recipient, amount);
    }

    /// @notice Withdraw desired amount from vault adapter, if the reserves are unable to
    ///     to cover the desired amount, start withdrawing from strategies in order specified.
    ///     The withdrawamount if set in shares and calculated in the underlying token the vault holds.
    /// @param _shares Amount to withdraw in shares
    /// @param _maxLoss Max accepted loss when withdrawing from strategy
    function withdraw(uint256 _shares, uint256 _maxLoss)
        external
        nonReentrant
        returns (uint256)
    {
        require(
            _maxLoss <= PERCENTAGE_DECIMAL_FACTOR,
            "withdraw: _maxLoss > 100%"
        );
        require(_shares > 0, "withdraw: _shares == 0");

        uint256 userBalance = balanceOf(msg.sender);
        uint256 shares = _shares == type(uint256).max
            ? balanceOf(msg.sender)
            : _shares;
        require(shares <= userBalance, "withdraw, shares > userBalance");
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
                uint256 withdrawn = _token.balanceOf(address(this)) -
                    vaultBalance;

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

            require(
                totalLoss <=
                    (_maxLoss * (value + totalLoss)) /
                        PERCENTAGE_DECIMAL_FACTOR,
                "withdraw: loss > maxloss"
            );
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
        return ((_shares * _totalAssets()) / _totalSupply);
    }

    /// @notice Value of tokens in shares
    /// @param _amount amount of tokens to convert to shares
    function _sharesForAmount(uint256 _amount) internal view returns (uint256) {
        uint256 _assets = _totalAssets();
        if (_assets > 0) {
            return (_amount * totalSupply()) / _assets;
        }
        return 0;
    }

    /// @notice Report back any gains/losses from a (strategy) harvest, vault adapetr
    ///     calls back debt or gives out more credit to the strategy depending on available
    ///     credit and the strategies current position.
    /// @param _gain Strategy gains from latest harvest
    /// @param _loss Strategy losses from latest harvest
    /// @param _debtPayment Amount strategy can pay back to vault
    function report(
        uint256 _gain,
        uint256 _loss,
        uint256 _debtPayment
    ) external returns (uint256) {
        StrategyParams storage _strategy = strategies[msg.sender];
        require(_strategy.active, "report: !activated");
        IERC20 _token = IERC20(token);
        require(
            _token.balanceOf(msg.sender) >= _gain + _debtPayment,
            "report: balance(strategy) < _gain + _debtPayment"
        );

        if (_loss > 0) {
            _reportLoss(msg.sender, _loss);
        }
        if (vaultFee > 0 && _gain > 0)
            _issueSharesForAmount(
                rewards,
                (_gain * vaultFee) / PERCENTAGE_DECIMAL_FACTOR
            );

        _strategy.totalGain = _strategy.totalGain + _gain;

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

        uint256 totalAvailable = _gain + debtPayment;

        if (totalAvailable < credit) {
            _token.safeTransfer(msg.sender, credit - totalAvailable);
        } else if (totalAvailable > credit) {
            _token.safeTransferFrom(
                msg.sender,
                address(this),
                totalAvailable - credit
            );
        }

        lastReport = block.timestamp;
        _strategy.lastReport = lastReport;

        emit LogStrategyReported(
            msg.sender,
            _gain,
            _loss,
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

    /// @notice Update a given strategies debt ratio
    /// @param _strategy target strategy
    /// @param _debtRatio new debt ratio
    /// @dev See setDebtRatios and setDebtRatio functions
    function _setDebtRatio(address _strategy, uint256 _debtRatio) internal {
        debtRatio -= strategies[_strategy].debtRatio;
        strategies[_strategy].debtRatio = _debtRatio;
        debtRatio += _debtRatio;
        emit LogNewDebtRatio(_strategy, _debtRatio);
    }

    /// @notice Gives the price for a single Vault share.
    /// @return The value of a single share.
    /// @dev See dev note on `withdraw`.
    function getPricePerShare() external view returns (uint256) {
        return _shareValue(10**_decimals);
    }

    /// @notice Get current enstimated amount of assets in strategy
    /// @param _index index of strategy
    function _getStrategyEstimatedTotalAssets(uint256 _index)
        internal
        view
        returns (uint256)
    {
        return IStrategy(withdrawalQueue[_index]).estimatedTotalAssets();
    }

    /// @notice Get strategy totalDebt
    /// @param _index index of strategy
    function _getStrategyTotalAssets(uint256 _index)
        internal
        view
        returns (uint256)
    {
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

    /// @notice Vault adapters total assets including loose assets and debts
    /// @dev note that this does not consider estimated gains/losses from the strategies
    function _totalAssets() private view returns (uint256) {
        return IERC20(token).balanceOf(address(this)) + totalDebt;
    }

    /// @notice Reorder the withdrawal queue to put the zero addresses at the end
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
