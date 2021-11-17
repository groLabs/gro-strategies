require("dotenv").config();
const MockERC20 = artifacts.require("MockERC20");
const TestStrategy = artifacts.require("TestStrategy");
const VaultAdaptor = artifacts.require("VaultAdaptorMK2");

const { toBN, BN, toWei } = web3.utils;
const { constants } = require("./utils/constants");
const {
  expect,
  ZERO,
  tokens,
  setBalance,
  setStorageAt,
  toBytes32,
} = require("./utils/common-utils");
const allowance = toBN(1e18);

let usdcAdaptor,
  usdc,
  primaryStrategy,
  secondaryStrategy,
  admin,
  governance,
  bot,
  investor1,
  investor2,
  bouncer;

contract("VaultAdapter test", function (accounts) {
  admin = accounts[0];
  governance = accounts[1];
  bouncer = accounts[2];
  bot = accounts[3];
  investor1 = accounts[8];
  investor2 = accounts[9];
  investor3 = accounts[10];

  async function snapshotChain() {
    return await network.provider.request({
      method: "evm_snapshot",
      params: [],
    });
  }

  async function revertChain(snapshotId) {
    await network.provider.request({
      method: "evm_revert",
      params: [snapshotId],
    });
  }

  beforeEach(async function () {
    // Set up stablecoins + mocks needed for the vault adapter
    usdc = await MockERC20.at(tokens.usdc.address);

    // create the vault adapter
    usdcAdaptor = await VaultAdaptor.new(tokens.usdc.address, bouncer, {
      from: governance,
    });

    // create and add the AHv2 strategy to the adapter
    primaryStrategy = await TestStrategy.new(usdcAdaptor.address);
    await primaryStrategy.setKeeper(usdcAdaptor.address, { from: governance });
    const botLimit = toBN(0);
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    await usdcAdaptor.addStrategy(
      primaryStrategy.address,
      6000, // set debtRatio to 100%
      botLimit,
      topLimit,
      { from: governance }
    );

    // add a secondary dummy strategy, potentially not necessary but we have done
    // all modelling with the assumption that we have 2 strategies per vault min.
    secondaryStrategy = await TestStrategy.new(usdcAdaptor.address);
    await secondaryStrategy.setKeeper(usdcAdaptor.address, {
      from: governance,
    });
    await usdcAdaptor.addStrategy(
      secondaryStrategy.address,
      4000,
      botLimit,
      topLimit,
      { from: governance }
    );

    await usdcAdaptor.addToWhitelist(bot, { from: governance });
    await usdcAdaptor.setDepositLimit(constants.MAX_UINT256, {
      from: governance,
    });
    await usdc.approve(usdcAdaptor.address, constants.MAX_UINT256, {
      from: investor1,
    });
    await usdcAdaptor.setUserAllowance(investor1, allowance, { from: bouncer });
    await usdc.approve(usdcAdaptor.address, constants.MAX_UINT256, {
      from: investor2,
    });
    await usdcAdaptor.setUserAllowance(investor2, allowance, { from: bouncer });

    for (let i = 0; i < 10; i++) {
      await network.provider.send("evm_mine");
    }
  });

  // The strategy needs to be able to open positions in AHv2
  describe("Deposit", function () {
    it("Should revert when a user is depositing 0 assets", async () => {
      return expect(usdcAdaptor.deposit(0), {
        from: investor1,
      }).to.eventually.be.rejectedWith("deposit: _amount !> 0");
    });

    it("Should revert when the deposit is greater than userAllowance", async () => {
      const amount = "10000";
      await setBalance("usdc", investor3, amount);
      return expect(usdcAdaptor.deposit(1), {
        from: investor3,
      }).to.eventually.be.rejectedWith("deposit: !userAllowance");
    });

    it("Should revert when depositing above the depositLimit", async () => {
      const amount = "10000";
      await usdcAdaptor.setDepositLimit(toBN(amount).mul(toBN(1e6)), {
        from: governance,
      });
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await setBalance("usdc", investor1, amount);
      return expect(usdcAdaptor.deposit(1), {
        from: investor1,
      }).to.eventually.be.rejectedWith("deposit: !depositLimit");
    });

    it("Should be possible to deposit", async () => {
      const amount = "10000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      await setBalance("usdc", investor1, amount);
      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await usdcAdaptor.deposit(norm_amount, { from: investor1 });
      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount);
      return expect(
        usdcAdaptor.totalAssets()
      ).to.eventually.be.a.bignumber.equal(norm_amount);
    });
  });

  describe("Withdrawal", function () {
    beforeEach(async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await setBalance("usdc", investor2, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor2,
      });
    });

    it("Should revert when user has no assets", async () => {
      return expect(usdcAdaptor.withdraw(100, 0), {
        from: investor3,
      }).to.eventually.be.rejectedWith("withdraw, shares > userBalance");
    });

    it("Should be possible to withdraw the full amount", async () => {
      const amount = "10000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      const adaptor_assets = await usdcAdaptor.totalAssets();

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount);
      await expect(usdcAdaptor.withdraw(norm_amount, 0, { from: investor1 })).to
        .eventually.be.fulfilled;

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await expect(
        usdc.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount);
      await expect(
        usdcAdaptor.totalSupply()
      ).to.eventually.be.a.bignumber.equal(adaptor_assets.sub(norm_amount));
      return expect(
        usdcAdaptor.totalAssets()
      ).to.eventually.be.a.bignumber.equal(adaptor_assets.sub(norm_amount));
    });

    it("Should be possible to withdraw a partial amount", async () => {
      const amount = "1000";
      const orig_amount = toBN("10000").mul(toBN(1e6));
      const norm_amount = toBN(amount).mul(toBN(1e6));
      const leftover = orig_amount.sub(norm_amount);
      const adaptor_assets = await usdcAdaptor.totalAssets();

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(orig_amount);
      await expect(usdcAdaptor.withdraw(norm_amount, 0, { from: investor1 })).to
        .eventually.be.fulfilled;

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(leftover);
      await expect(
        usdc.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount);
      await expect(
        usdcAdaptor.totalSupply()
      ).to.eventually.be.a.bignumber.equal(adaptor_assets.sub(norm_amount));
      return expect(
        usdcAdaptor.totalAssets()
      ).to.eventually.be.a.bignumber.equal(adaptor_assets.sub(norm_amount));
    });

    it("Should be possible to withdraw from strategies if vault doesnt have sufficient assets", async () => {
      const adaptor_balance = await usdc.balanceOf(usdcAdaptor.address);
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      await setBalance("usdc", primaryStrategy.address, "0");
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(
        usdc.balanceOf(usdcAdaptor.address)
      ).to.eventually.be.a.bignumber.lt(adaptor_balance);
      const amount = "5000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      const norm_amount_usdc = toBN(amount)
        .mul(toBN(1e6))
        .mul(await usdcAdaptor.getPricePerShare())
        .div(toBN(1e6));
      const adaptor_assets = await usdcAdaptor.totalAssets();
      const adaptor_supply = await usdcAdaptor.totalSupply();

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(toBN("10000").mul(toBN(1e6))); // init vault token amount
      await expect(usdcAdaptor.withdraw(norm_amount, 0, { from: investor1 })).to
        .eventually.be.fulfilled;

      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount); // final vault token amount
      await expect(
        usdc.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount_usdc);
      await expect(
        usdcAdaptor.totalSupply()
      ).to.eventually.be.a.bignumber.equal(adaptor_supply.sub(norm_amount));
      return expect(
        usdcAdaptor.totalAssets()
      ).to.eventually.be.a.bignumber.equal(
        adaptor_assets.sub(norm_amount_usdc)
      );
    });

    it("Should be possible to withdraw with a loss", async () => {
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      const adapter_total_balance = await usdcAdaptor.totalSupply();

      const adaptor_assets = await usdcAdaptor.totalAssets();

      await setBalance("usdc", primaryStrategy.address, "13500"); // 1500 want gain
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      const amount = "10000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      await usdcAdaptor.withdraw(norm_amount, 50, { from: investor2 });

      await setBalance("usdc", secondaryStrategy.address, "6000"); // 50 want loss
      await usdcAdaptor.withdraw(norm_amount, 5000, { from: investor1 });
      await expect(
        usdcAdaptor.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.lt(
        norm_amount
      );
      await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(
        toBN(0)
      );
      await expect(
        usdcAdaptor.totalSupply()
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      return expect(
        usdcAdaptor.totalAssets()
      ).to.eventually.be.a.bignumber.equal(toBN(0));
    });

    it("Should revert if withdrawal loss is above max allowed loss", async () => {
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      const adapter_total_balance = await usdcAdaptor.totalSupply();

      const amount = "5000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const norm_amount = toBN(amount).mul(toBN(1e6));

      return expect(
        usdcAdaptor.withdraw(norm_amount, 50, { from: investor1 })
      ).to.eventually.be.rejectedWith("withdraw: loss > maxloss");
    });

    it("Should adapt during withdrawal if loss isnt reported correctly", async () => {
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      const adapter_total_balance = await usdcAdaptor.totalSupply();

      const amount = "10000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const norm_amount = toBN(amount).mul(toBN(1e6));

      await primaryStrategy.setNoLossStrategy();
      await secondaryStrategy.setNoLossStrategy();
      await usdcAdaptor.withdraw(norm_amount, 50, { from: investor1 });
      await usdcAdaptor.withdraw(norm_amount, 800, { from: investor2 });
      await expect(
        usdc.balanceOf(investor1)
      ).to.eventually.be.a.bignumber.equal(norm_amount);
      return expect(usdc.balanceOf(investor2)).to.eventually.be.a.bignumber.lt(
        norm_amount
      );
    });

    it("Should adapt during withdrawal if loss isnt reported correctly part ", async () => {
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      const adapter_total_balance = await usdcAdaptor.totalSupply();

      const amount = "10000";
      await setBalance("usdc", primaryStrategy.address, "0");
      const norm_amount = toBN(amount).mul(toBN(1e6));

      await primaryStrategy.setNoLossStrategy();
      await secondaryStrategy.setNoLossStrategy();
      await usdcAdaptor.withdraw(norm_amount, 1000, { from: investor1 });
      await usdcAdaptor.withdraw(norm_amount, 10000, { from: investor2 });
      await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.lt(
        norm_amount
      );
      return expect(usdc.balanceOf(investor2)).to.eventually.be.a.bignumber.eq(
        toBN(0)
      );
    });

    it("Should revert if withdrawal loss is above max allowed loss", async () => {
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });

      const amount = "10000"; // user base amount
      const norm_amount = toBN(amount).mul(toBN(1e6));
      // user 1 withdraws all
      usdcAdaptor.withdraw(norm_amount, 50, { from: investor1 });

      const amount_loss = "7000"; // secondary strategy loss $ 1000
      await setBalance("usdc", secondaryStrategy.address, amount_loss);

      const norm_amount_loss = toBN("9000").mul(toBN(1e6));
      await usdcAdaptor.withdraw(norm_amount, 2000, { from: investor2 });
      // await expect().to.eventually.be.fulfilled;
      await expect(
        usdcAdaptor.balanceOf(investor2)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      return expect(
        usdc.balanceOf(investor2)
      ).to.eventually.be.a.bignumber.equal(norm_amount_loss);
    });
  });

  // Adjusting the position by adding and removing assets - can be done during harvest events (adding credit) or withdrawals
  describe("Harvest Trigger", function () {
    beforeEach(async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
    });

    it("Should revert when calling harvestTrigger with index > strategyLength", async function () {
      return expect(
        usdcAdaptor.strategyHarvestTrigger(2, 0)
      ).to.eventually.be.rejectedWith("invalid index");
    });

    it("Should return false when calling the harvest trigger and there is no profit", async function () {
      const result = await usdcAdaptor.strategyHarvestTrigger(0, 0);
      return expect(result).equal(false);
    });

    it("Should return true when calling the harvest trigger and there is profit", async function () {
      const amount = "20000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const result = await usdcAdaptor.strategyHarvestTrigger(0, 0);
      return expect(result).equal(true);
    });

    it("Should return false when calling the harvest trigger and callcost exceeds profit", async function () {
      const profit = "20000";
      await setBalance("usdc", primaryStrategy.address, profit);
      const result = await usdcAdaptor.strategyHarvestTrigger(
        0,
        toBN(profit).mul(toBN(1e6))
      );
      return expect(result).equal(false);
    });

    it("Should return true when calling the harvest trigger and there has been a loss", async function () {
      const loss = "10000";
      await setBalance("usdc", primaryStrategy.address, loss);
      const result = await usdcAdaptor.strategyHarvestTrigger(0, 0);
      return expect(result).equal(true);
    });
  });

  describe("Fees", function () {
    beforeEach(async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.setRewards(governance, { from: governance });
      await usdcAdaptor.setVaultFee(2000, { from: governance });
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
    });

    it("Should mint assets to rewards account during harvest if there is a withdrawal fee", async function () {
      const amount = "22000";
      const gain = "16000"; // 22000 - 6000
      const norm_amount = toBN(gain).mul(toBN(1e6));
      await setBalance("usdc", primaryStrategy.address, amount);
      const adaptor_assets = await usdcAdaptor.totalAssets();
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalGain")
        .that.is.a.bignumber.equal(toBN(0));
      await expect(
        usdcAdaptor.balanceOf(governance)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      return expect(
        usdcAdaptor.balanceOf(governance)
      ).to.eventually.be.a.bignumber.equal(
        norm_amount.mul(toBN(2000)).div(toBN(10000))
      );
    });
  });

  describe("Harvest", function () {
    beforeEach(async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
    });

    it("Should revert when harvest is called with index > strategyLength", async () => {
      return expect(
        usdcAdaptor.strategyHarvest(2, 0, 0, { from: bot })
      ).to.eventually.be.rejectedWith("invalid index");
    });

    it("Should revert when strategy harvest is called by a none whitelist user", async () => {
      return expect(usdcAdaptor.strategyHarvest(0, 0, 0), {
        from: governance,
      }).to.eventually.be.rejectedWith("only whitelist");
    });

    it("Should report a profit when strategy is harvested with profit", async function () {
      const amount = "10000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const adaptor_assets = await usdcAdaptor.totalAssets();
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalGain")
        .that.is.a.bignumber.equal(toBN(0));
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(usdcAdaptor.totalAssets()).to.eventually.be.a.bignumber.gt(
        adaptor_assets
      );
      return expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalGain")
        .that.is.a.bignumber.gt(toBN(0));
    });

    it("Should report a loss when strategy is harvested with a loss", async function () {
      const amount = "5000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const adaptor_assets = await usdcAdaptor.totalAssets();
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalLoss")
        .that.is.a.bignumber.equal(toBN(0));
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(usdcAdaptor.totalAssets()).to.eventually.be.a.bignumber.lt(
        adaptor_assets
      );
      return expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalLoss")
        .that.is.a.bignumber.gt(toBN(0));
    });

    it("Should revert if the AMM price check fails", async function () {
      await primaryStrategy.setAmmCheck(false);
      return expect(
        usdcAdaptor.strategyHarvest(0, 10, 10, { from: bot })
      ).to.eventually.be.rejectedWith("strategyHarvest: !ammCheck");
    });

    it("Should proceed if the AMM price chack passes", async function () {
      return expect(
        usdcAdaptor.strategyHarvest(0, 10, 10, { from: bot })
      ).to.eventually.be.fulfilled;
    });

    it("Should not give any additional assets to strategy if gain below minDebtPerHarvest", async function () {
      const norm_amount_max = toBN("1000").mul(toBN(1e6));
      const norm_amount_min = toBN("100").mul(toBN(1e6));
      const secondary_debt = toBN("4000").mul(toBN(1e6));
      await usdcAdaptor.updateStrategyMaxDebtPerHarvest(
        secondaryStrategy.address,
        norm_amount_max,
        { from: governance }
      );
      await usdcAdaptor.updateStrategyMinDebtPerHarvest(
        secondaryStrategy.address,
        norm_amount_min,
        { from: governance }
      );
      await setBalance("usdc", usdcAdaptor.address, "40");
      await setBalance("usdc", secondaryStrategy.address, "4040");
      await expect(usdcAdaptor.strategies(secondaryStrategy.address))
        .to.eventually.have.property("totalDebt")
        .that.is.a.bignumber.equal(secondary_debt);
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
      return expect(usdcAdaptor.strategies(secondaryStrategy.address))
        .to.eventually.have.property("totalDebt")
        .that.is.a.bignumber.equal(secondary_debt);
    });

    it("Should not be possible to harvest inactivated strategy", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await usdcAdaptor.migrateStrategy(
        secondaryStrategy.address,
        testA.address,
        { from: governance }
      );
      await usdcAdaptor.setWithdrawalQueue(
        [primaryStrategy.address, secondaryStrategy.address],
        { from: governance }
      );
      return expect(
        usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot })
      ).to.eventually.be.rejectedWith("report: !activated");
    });

    it("Should not be possible for a strategy to report a higher gain than actually available to the vault", async function () {
      await primaryStrategy.setToMuchGain();
      await setBalance("usdc", primaryStrategy.address, "13000"); // simulate gain
      return expect(
        usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot })
      ).to.eventually.be.rejectedWith(
        "report: balance(strategy) < _gain + _debtPayment"
      );
    });

    it("Should not be possible for a strategy do report a higher loss than actually possible to the vault", async function () {
      await primaryStrategy.setToMuchLoss();
      await setBalance("usdc", primaryStrategy.address, "10000"); // simulate loss
      return expect(
        usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot })
      ).to.eventually.be.rejectedWith("_reportLoss: totalDebt >= loss");
    });

    it("Should possible for the vault to withdraw all strategy assets", async function () {
      await usdcAdaptor.setDebtRatio(primaryStrategy.address, 0, {
        from: governance,
      });
      const totalBalance = await usdc.balanceOf(usdcAdaptor.address);
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("totalDebt")
        .that.is.a.bignumber.equal(toBN(0));
      return expect(
        usdc.balanceOf(usdcAdaptor.address)
      ).to.eventually.be.a.bignumber.gt(totalBalance);
    });

    it("Should be possible for the vault to handle a debt repayment", async function () {
      await expect(
        usdcAdaptor.debtOutstanding(primaryStrategy.address)
      ).to.eventually.be.a.bignumber.eq(toBN(0));
      await usdcAdaptor.setDebtRatio(primaryStrategy.address, 2000, {
        from: governance,
      });
      await expect(
        usdcAdaptor.debtOutstanding(primaryStrategy.address)
      ).to.eventually.be.a.bignumber.gt(toBN(0));
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      return expect(
        usdcAdaptor.debtOutstanding(primaryStrategy.address)
      ).to.eventually.be.a.bignumber.eq(toBN(0));
    });
  });

  describe("Assets", function () {
    beforeEach(async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await usdcAdaptor.strategyHarvest(1, 0, 0, { from: bot });
    });

    it("Should increase the value of user assets after reporting a profit", async function () {
      const amount = "10000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const shareValue = await usdcAdaptor.getPricePerShare();
      const adaptor_assets = await usdcAdaptor.totalAssets();
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(usdcAdaptor.totalAssets()).to.eventually.be.a.bignumber.gt(
        adaptor_assets
      );
      return expect(
        usdcAdaptor.getPricePerShare()
      ).to.eventually.be.a.bignumber.gt(shareValue);
    });

    it("Should decrease the value of user assets after reporting a loss", async function () {
      const amount = "5000";
      await setBalance("usdc", primaryStrategy.address, amount);
      const shareValue = await usdcAdaptor.getPricePerShare();
      const adaptor_assets = await usdcAdaptor.totalAssets();
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(usdcAdaptor.totalAssets()).to.eventually.be.a.bignumber.lt(
        adaptor_assets
      );
      return expect(
        usdcAdaptor.getPricePerShare()
      ).to.eventually.be.a.bignumber.lt(shareValue);
    });

    it("Should not affect the value of users assets when withdrawing", async function () {
      const amount = "10000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      const shareValue = await usdcAdaptor.getPricePerShare();
      await usdcAdaptor.withdraw(norm_amount, 50, { from: investor1 });
      return expect(
        usdcAdaptor.getPricePerShare()
      ).to.eventually.be.a.bignumber.equal(shareValue);
    });
  });

  describe("Utility", function () {
    it("Should be possible to update the withdrawal queue", async function () {
      await expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.not.equal(
        ZERO
      );
      await expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.equal(
        primaryStrategy.address
      );
      await usdcAdaptor.setWithdrawalQueue(
        [secondaryStrategy.address, primaryStrategy.address],
        { from: governance }
      );
      return expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.be.equal(
        secondaryStrategy.address
      );
    });

    it("Should revert if new queue exceeds MAX length", async function () {
      const primAddress = primaryStrategy.address;
      const newQueue = [
        primAddress,
        primAddress,
        primAddress,
        primAddress,
        primAddress,
        primAddress,
      ];
      return expect(
        usdcAdaptor.setWithdrawalQueue(newQueue, { from: governance })
      ).to.eventually.be.rejectedWith(
        "setWithdrawalQueue: > MAXIMUM_STRATEGIES"
      );
    });

    it("Should return max value if the queue is full", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      const testB = await TestStrategy.new(usdcAdaptor.address);
      const testC = await TestStrategy.new(usdcAdaptor.address);
      await usdcAdaptor.addStrategy(testA.address, 0, 0, 1, {
        from: governance,
      });
      await usdcAdaptor.addStrategy(testB.address, 0, 0, 1, {
        from: governance,
      });
      await usdcAdaptor.addStrategy(testC.address, 0, 0, 1, {
        from: governance,
      });
      const maxStrats = await usdcAdaptor.MAXIMUM_STRATEGIES();
      return expect(
        usdcAdaptor.getStrategiesLength()
      ).to.eventually.be.a.bignumber.equal(maxStrats);
    });

    it("Should be able to migrate strategy", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await usdcAdaptor.migrateStrategy(
        secondaryStrategy.address,
        testA.address,
        { from: governance }
      );
      return expect(usdcAdaptor.withdrawalQueue(1)).to.eventually.be.equal(
        testA.address
      );
    });

    it("Should should be possible to sweep for unwanted tokens", async function () {
      const usdt = await MockERC20.at(tokens.usdt.address);
      const amount = "10000";
      await setBalance("usdt", usdcAdaptor.address, amount);
      await expect(
        usdt.balanceOf(governance)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await usdcAdaptor.sweep(usdt.address, governance, { from: governance });
      return expect(usdt.balanceOf(governance)).to.eventually.be.a.bignumber.gt(
        toBN(0)
      );
    });

    it("Should not be possible to sweep want", async function () {
      return expect(
        usdcAdaptor.sweep(usdc.address, governance, { from: governance })
      ).to.eventually.be.rejectedWith("sweep: token == want");
    });

    it("Should be possible to get outstanding debt from a strategy", async function () {
      await expect(
        usdcAdaptor.debtOutstanding(primaryStrategy.address)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await setBalance("usdc", usdcAdaptor.address, "0");
      return expect(
        usdcAdaptor.debtOutstanding(primaryStrategy.address)
      ).to.eventually.be.a.bignumber.gt(toBN(0));
    });

    it("Should be possible to get credit available for a strategy", async function () {
      const amount = "10000";
      credit = await usdcAdaptor.methods["creditAvailable(address)"](
        primaryStrategy.address
      );
      return expect(
        usdcAdaptor.methods["creditAvailable(address)"](primaryStrategy.address)
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      return expect(
        usdcAdaptor.methods["creditAvailable(address)"](primaryStrategy.address)
      ).to.eventually.be.a.bignumber.gt(credit);
    });

    it("Should be possible to update strategy harvest debt threshold", async function () {
      const stratData = await usdcAdaptor.strategies(primaryStrategy.address);
      await usdcAdaptor.updateStrategyMinDebtPerHarvest(
        primaryStrategy.address,
        1,
        { from: governance }
      );
      await usdcAdaptor.updateStrategyMaxDebtPerHarvest(
        primaryStrategy.address,
        2,
        { from: governance }
      );
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("minDebtPerHarvest")
        .that.is.a.bignumber.equal(toBN(1));
      return expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("maxDebtPerHarvest")
        .that.is.a.bignumber.equal(toBN(2));
    });

    it("Should be possible to add and remove StrategyFrom the queue", async function () {
      await expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.equal(
        primaryStrategy.address
      );
      await expect(
        usdcAdaptor.removeStrategyFromQueue(primaryStrategy.address, {
          from: governance,
        })
      ).to.be.fulfilled;
      await expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.not.equal(
        primaryStrategy.address
      );
      await expect(usdcAdaptor.withdrawalQueue(1)).to.eventually.equal(ZERO);
      await expect(
        usdcAdaptor.addStrategyToQueue(primaryStrategy.address, {
          from: governance,
        })
      ).to.be.fulfilled;
      return expect(usdcAdaptor.withdrawalQueue(1)).to.eventually.equal(
        primaryStrategy.address
      );
    });

    it("Should be possible to update a single strategies debt ratio", async function () {
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(6000));
      // cant set debt ratio so that global debt ratio is above 100%
      await expect(
        usdcAdaptor.setDebtRatio(primaryStrategy.address, 10000, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("setDebtRatio: debtRatio > 100%");
      await expect(
        usdcAdaptor.setDebtRatio(primaryStrategy.address, 5000, {
          from: governance,
        })
      ).to.eventually.be.fulfilled;
      return expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(5000));
    });

    it("Should be possible to update all strategies debt ratios", async function () {
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(6000));
      await expect(usdcAdaptor.strategies(secondaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(4000));
      // cant set debt ratio so that global debt ratio is above 100%
      await expect(
        usdcAdaptor.setDebtRatios([6000, 6000], { from: governance })
      ).to.eventually.be.rejectedWith("setDebtRatios: debtRatio > 100%");
      await expect(
        usdcAdaptor.setDebtRatios([7000, 3000], { from: governance })
      ).to.eventually.be.fulfilled;
      await expect(usdcAdaptor.strategies(primaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(7000));
      return expect(usdcAdaptor.strategies(secondaryStrategy.address))
        .to.eventually.have.property("debtRatio")
        .that.is.a.bignumber.equal(toBN(3000));
    });

    it("Should be possible to get a strategies debt", async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });

      // Impersonate AH governance so that we an add this strategy to the whitelist
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [primaryStrategy.address],
      });
      await hre.network.provider.request({
        method: "hardhat_setBalance",
        params: [primaryStrategy.address, "0x100000000000000000"],
      });

      await expect(
        usdcAdaptor.strategyDebt({ from: primaryStrategy.address })
      ).to.eventually.be.a.bignumber.equal(toBN(0));
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      await expect(
        usdcAdaptor.strategyDebt({ from: primaryStrategy.address })
      ).to.eventually.be.a.bignumber.gt(toBN(0));
    });

    it("Should be possible to revoke a strategy", async function () {
      // Impersonate AH governance so that we an add this strategy to the whitelist
      await hre.network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [primaryStrategy.address],
      });

      await hre.network.provider.request({
        method: "hardhat_setBalance",
        params: [primaryStrategy.address, "0x100000000000000000"],
      });
      await expect(usdcAdaptor.withdrawalQueue(0)).to.eventually.be.equal(
        primaryStrategy.address
      );
      await usdcAdaptor.revokeStrategy({ from: primaryStrategy.address });
      await expect(
        usdcAdaptor.strategyDebt({ from: primaryStrategy.address })
      ).to.eventually.not.equal(primaryStrategy.address);
      // Cannort revoke an incative strategy
      return expect(
        usdcAdaptor.revokeStrategy({ from: investor1 })
      ).to.eventually.be.rejectedWith("revokeStrategy: strategy not active");
    });

    it("Should be possible to get estimated assets of a strategy", async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), {
        from: investor1,
      });
      await usdcAdaptor.strategyHarvest(0, 0, 0, { from: bot });
      const totalDebt = await usdcAdaptor.getStrategyAssets(0);
      const totalBalance = await usdc.balanceOf(usdcAdaptor.address);
      await expect(
        usdcAdaptor.totalEstimatedAssets()
      ).to.eventually.be.a.bignumber.equal(totalDebt.add(totalBalance));
      // simulate gain
      await setBalance("usdc", primaryStrategy.address, amount);
      return expect(
        usdcAdaptor.totalEstimatedAssets()
      ).to.eventually.be.a.bignumber.gt(totalDebt.add(totalBalance));
    });
  });

  describe("Access and other control", function () {
    it("Should only be possible for the bouncer to set user allowance", async function () {
      return expect(
        usdcAdaptor.setUserAllowance(investor1, constants.MAX_UINT256)
      ).to.eventually.be.rejectedWith(
        "setUserAllowance: msg.sender != bouncer"
      );
    });

    it("Should not be possible to deposit above the vaults deposit limit", async function () {
      const amount = "10000";
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.setDepositLimit(amount, { from: governance });
      await expect(
        usdcAdaptor.deposit(amount, { from: investor1 })
      ).to.eventually.be.fulfilled;
      return expect(
        usdcAdaptor.deposit(1, { from: investor1 })
      ).to.eventually.be.rejectedWith("deposit: !depositLimit");
    });

    it("Should not be possible to deposit more than a users allowance", async function () {
      const amount = "10000";
      await setBalance("usdc", investor3, amount);
      await usdcAdaptor.setUserAllowance(investor3, amount, { from: bouncer });
      await usdc.approve(usdcAdaptor.address, constants.MAX_UINT256, {
        from: investor3,
      });
      await expect(
        usdcAdaptor.deposit(toBN(amount).mul(toBN(1e6)), { from: investor3 })
      ).to.eventually.be.fulfilled;
      return expect(
        usdcAdaptor.deposit(1, { from: investor3 })
      ).to.eventually.be.rejectedWith("deposit: !userAllowance");
    });

    it("Should not be possible to set a withdrawalQueue with more strats than the max cap", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      const testB = await TestStrategy.new(usdcAdaptor.address);
      const testC = await TestStrategy.new(usdcAdaptor.address);
      const testD = await TestStrategy.new(usdcAdaptor.address);

      const botLimit = toBN(0);
      const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));
      await usdcAdaptor.addStrategy(testA.address, 0, botLimit, topLimit, {
        from: governance,
      });

      await usdcAdaptor.addStrategy(testB.address, 0, botLimit, topLimit, {
        from: governance,
      });

      await usdcAdaptor.addStrategy(testC.address, 0, botLimit, topLimit, {
        from: governance,
      });

      await expect(
        usdcAdaptor.addStrategy(testD.address, 0, botLimit, topLimit, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("addStrategy: > MAXIMUM_STRATEGIES");

      await expect(
        usdcAdaptor.addStrategyToQueue(testD.address, { from: governance })
      ).to.eventually.be.rejectedWith("addStrategyToQueue: !activated");
    });

    it("Should not be possible to add or remove strategies from the withdrawal queue if not owner or whitelisted", async function () {
      return expect(
        usdcAdaptor.removeStrategyFromQueue(primaryStrategy.address, {
          from: investor1,
        })
      ).to.eventually.be.rejectedWith(
        "removeStrategyFromQueue: !owner|whitelist"
      );
    });

    it("Should not be possible to add an already existing strategy to the withdrawal queue", async function () {
      return expect(
        usdcAdaptor.addStrategyToQueue(primaryStrategy.address, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith(
        "addStrategyToQueue: strategy already in queue"
      );
    });

    it("Should not be possible to add a strategy to the withdrawal queue if not authorized", async function () {
      return expect(
        usdcAdaptor.addStrategyToQueue(primaryStrategy.address, {
          from: investor1,
        })
      ).to.eventually.be.rejectedWith("addStrategyToQueue: !owner|whitelist");
    });

    it("Should not be possible to add a not activated strategy to the withdrawal queue", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      return expect(
        usdcAdaptor.addStrategyToQueue(testA.address, { from: governance })
      ).to.eventually.be.rejectedWith("addStrategyToQueue: !activated");
    });

    it("Should not be possible to add to the withdrawal queue if its full", async function () {
      const primAddress = primaryStrategy.address;
      const newQueue = [
        primAddress,
        primAddress,
        primAddress,
        primAddress,
        primAddress,
      ];
      await usdcAdaptor.setWithdrawalQueue(newQueue, { from: governance });
      return expect(
        usdcAdaptor.addStrategyToQueue(secondaryStrategy.address, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("addStrategyToQueue: queue full");
    });

    it("Should only allow owner or whitelisted user to set debtRatios", async function () {
      await expect(
        usdcAdaptor.setDebtRatio(primaryStrategy.address, 100, {
          from: investor1,
        })
      ).to.eventually.be.rejectedWith("setDebtRatio: !whitelist");
      await expect(
        usdcAdaptor.setDebtRatios([3000, 3000], { from: investor1 })
      ).to.eventually.be.rejectedWith("setDebtRatios: !whitelist");
    });

    it("Should not be possible to set ratios for more strategies than the max cap", async function () {
      await expect(
        usdcAdaptor.setDebtRatios([3000, 3000, 10, 10, 10, 10], {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("setDebtRatios: > MAXIMUM_STRATEGIES");
    });

    it("Should not be possible to update strageyDebt ratios if strategy is not active", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await usdcAdaptor.setDebtRatios([3000, 3000], { from: governance });
      await expect(
        usdcAdaptor.setDebtRatio(testA.address, 100, { from: governance })
      ).to.eventually.be.rejectedWith("setDebtRatio: !active");
    });

    it("Should not be possible to set max debt ratio below min ratio and vice versa", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await expect(
        usdcAdaptor.updateStrategyMinDebtPerHarvest(testA.address, 0, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith(
        "updateStrategyMinDebtPerHarvest: !activated"
      );
      await expect(
        usdcAdaptor.updateStrategyMaxDebtPerHarvest(testA.address, 0, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith(
        "updateStrategyMaxDebtPerHarvest: !activated"
      );

      await expect(
        usdcAdaptor.updateStrategyMinDebtPerHarvest(
          primaryStrategy.address,
          100,
          { from: governance }
        )
      ).to.eventually.be.fulfilled;
      await expect(
        usdcAdaptor.updateStrategyMaxDebtPerHarvest(
          primaryStrategy.address,
          1000,
          { from: governance }
        )
      ).to.eventually.be.fulfilled;

      await expect(
        usdcAdaptor.updateStrategyMinDebtPerHarvest(
          primaryStrategy.address,
          1001,
          { from: governance }
        )
      ).to.eventually.be.rejectedWith(
        "updateStrategyMinDebtPerHarvest: min > max"
      );
      await expect(
        usdcAdaptor.updateStrategyMaxDebtPerHarvest(
          primaryStrategy.address,
          99,
          { from: governance }
        )
      ).to.eventually.be.rejectedWith(
        "updateStrategyMaxDebtPerHarvest: min > max"
      );
    });

    it("Should not be possible to migrate a strategy to the zero address", async function () {
      return expect(
        usdcAdaptor.migrateStrategy(secondaryStrategy.address, ZERO, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("migrateStrategy: 0x");
    });

    it("Should be possible to remove a strategy from the withdrawalQueue", async function () {
      await expect(usdcAdaptor.withdrawalQueue(1)).to.eventually.be.equal(
        secondaryStrategy.address
      );
      await usdcAdaptor.removeStrategyFromQueue(secondaryStrategy.address, {
        from: governance,
      });
      return expect(usdcAdaptor.withdrawalQueue(1)).to.eventually.be.equal(
        ZERO
      );
    });

    it("Should not be possible to migrate a strategy from an inactive strategy or migrate to an already active strategy", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await expect(
        usdcAdaptor.migrateStrategy(
          secondaryStrategy.address,
          primaryStrategy.address,
          { from: governance }
        )
      ).to.eventually.be.rejectedWith("migrateStrategy: newVersion activated");
      return expect(
        usdcAdaptor.migrateStrategy(testA.address, secondaryStrategy.address, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("migrateStrategy: oldVersion !activated");
    });

    it("Should not be possible to revoke an incative strategy", async function () {
      const testA = await TestStrategy.new(usdcAdaptor.address);
      await usdcAdaptor.migrateStrategy(
        secondaryStrategy.address,
        testA.address,
        { from: governance }
      );
      const testB = await TestStrategy.new(usdcAdaptor.address);
      return expect(
        usdcAdaptor.migrateStrategy(secondaryStrategy.address, testB.address, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("migrateStrategy: oldVersion !active");
    });

    it("Should not be possible to specify a maxloss > 100% when withdrawing", async function () {
      const amount = "10000";
      const norm_amount = toBN(amount).mul(toBN(1e6));
      await setBalance("usdc", investor1, amount);
      await usdcAdaptor.deposit(norm_amount, { from: investor1 });
      return expect(
        usdcAdaptor.withdraw(norm_amount, 10001, { from: investor1 })
      ).to.eventually.be.rejectedWith("withdraw: _maxLoss > 100%");
    });

    it("Should not be possible to withdraw 0 shares", async function () {
      return expect(
        usdcAdaptor.withdraw(0, 1, { from: investor1 })
      ).to.eventually.be.rejectedWith("withdraw: _shares == 0");
    });

    it("Should only be possible for a strategy to revoke itself", async function () {
      return expect(
        usdcAdaptor.revokeStrategy({ from: investor1 })
      ).to.eventually.be.rejectedWith("revokeStrategy: strategy not active");
    });

    it("Should be possible to set a new bouncer", async function () {
      await expect(usdcAdaptor.bouncer()).to.eventually.not.equal(investor1);
      await usdcAdaptor.setBouncer(investor1, { from: governance });
      return expect(usdcAdaptor.bouncer()).to.eventually.be.equal(investor1);
    });

    it("Should be possibe to set a new rewards account", async function () {
      await expect(usdcAdaptor.rewards()).to.eventually.not.equal(investor1);
      await usdcAdaptor.setRewards(investor1, { from: governance });
      return expect(usdcAdaptor.rewards()).to.eventually.be.equal(investor1);
    });

    it("Should be possible to set a new vaultFee", async function () {
      await expect(usdcAdaptor.vaultFee()).to.eventually.be.a.bignumber.equal(
        toBN(0)
      );
      await usdcAdaptor.setVaultFee(1000, { from: governance });
      return expect(usdcAdaptor.vaultFee()).to.eventually.be.a.bignumber.equal(
        toBN(1000)
      );
    });

    it("Should revert for way to many reasons when trynig to add a strategy", async function () {
      // can add zero address as a strategy
      await expect(
        usdcAdaptor.addStrategy(ZERO, 0, 0, 1, { from: governance })
      ).to.eventually.be.rejectedWith("addStrategy: address(0x)");

      // cant add already active strategy
      await expect(
        usdcAdaptor.addStrategy(primaryStrategy.address, 0, 0, 1, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("addStrategy: !activated");

      // strategy added has to be linked to the vault
      const usdcAdaptorNew = await VaultAdaptor.new(
        tokens.usdc.address,
        bouncer,
        { from: governance }
      );
      const testA = await TestStrategy.new(usdcAdaptorNew.address);
      await expect(
        usdcAdaptor.addStrategy(testA.address, 0, 0, 1, { from: governance })
      ).to.eventually.be.rejectedWith("addStrategy: !vault");

      // Debt ratio cant exceed 100% when adding a new strategy
      const testB = await TestStrategy.new(usdcAdaptor.address);
      await expect(
        usdcAdaptor.addStrategy(testB.address, 10000, 0, 1, {
          from: governance,
        })
      ).to.eventually.be.rejectedWith("addStrategy: debtRatio > 100%");

      // MaxDebt needs to be > than MinDebt
      await expect(
        usdcAdaptor.addStrategy(testB.address, 0, 1, 0, { from: governance })
      ).to.eventually.be.rejectedWith("addStrategy: min > max");
    });
  });
});
