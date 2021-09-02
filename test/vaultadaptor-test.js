const MockController = artifacts.require('MockController')
const MockInsurance = artifacts.require('MockInsurance')
const MockPnL = artifacts.require('MockPnL')
const MockDAI = artifacts.require('MockDAI')
const MockUSDC = artifacts.require('MockUSDC')
const TestStrategy = artifacts.require('TestStrategy')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')
const { toBN, BN } = web3.utils
const { constants } = require('./utils/constants');
const { expect, ZERO  } = require('./utils/common-utils');

contract('Vault Adaptor Test', function (accounts) {
  const admin = accounts[0]
  const governance = accounts[1]
  const pool = accounts[5]
  const investor1 = accounts[8]
  const investor2 = accounts[9]
  const amount = new BN(10000)
  const zero = new BN(0)
  const decimal = new BN(10).pow(new BN(15))
  const daiBaseNum = new BN(10).pow(new BN(18))
  let daiAdaptor, mockController, mockInsurance, mockPnL,
    mockDAI,
    daiVault,
    primaryStrategy,
    secondaryStrategy,
    arrayStrategy,
    arrayStrategyAddresses,
    estimatedTotalAssets,
    triggers,
    percents,
    thresholds,
    strategiesQueue,
    limitArray
  beforeEach(async function () {
    mockController = await MockController.new();
    mockInsurance = await MockInsurance.new();
    mockPnL = await MockPnL.new();
    await mockController.setInsurance(mockInsurance.address);
    await mockController.setPnL(mockPnL.address);

    // init underlying tokens
    mockDAI = await MockDAI.new()
    // init vault

    daiAdaptor = await VaultAdaptor.new(mockDAI.address, { from: governance });
    daiVault = daiAdaptor;
    await daiAdaptor.setController(mockController.address, { from: governance });

    primaryStrategy = await TestStrategy.new(daiVault.address)
    await primaryStrategy.setKeeper(daiAdaptor.address, {from: governance})
    const botLimit = toBN(0)
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));
    await daiVault.addStrategy(
      primaryStrategy.address,
      6000,
      botLimit, topLimit,
      { from: governance }
    )

    secondaryStrategy = await TestStrategy.new(daiVault.address)
    await secondaryStrategy.setKeeper(daiAdaptor.address, {from: governance})
    await daiVault.addStrategy(
      secondaryStrategy.address,
      4000,
      botLimit, topLimit,
      { from: governance }
    )

    await expect(daiAdaptor.getStrategiesLength()).to.eventually.be.bignumber.equal(toBN(2), { from: governance });

    // mockDAIS1 = await MockStrategy.new(mockDAI.address)
    // await mockDAIS1.setVault(mockDAIVault.address)
    // mockDAIS2 = await MockStrategy.new(mockDAI.address)
    // await mockDAIS2.setVault(mockDAIVault.address);
  })

  const calculateTrigger = function (
    uninvestedTotal,
    strategies,
    estimatedTotalAssets,
    triggers,
    percents,
    thresholds,
    decimal,
  ) {
    const totalAssets = estimatedTotalAssets
      .reduce((accumulator, currentValue) => accumulator.add(currentValue))
      .add(uninvestedTotal)
    const queue = [],
      lastQueue = []
    const expectedAsset = [],
      lastExpectedAsset = []
    strategies.forEach((s, i) => {
      const asset = estimatedTotalAssets[i]
      const trigger = triggers[i]
      const p = percents[i]
      const t = thresholds[i]
      const ratio = asset.mul(decimal).divRound(totalAssets)
      const expected = totalAssets.mul(p).divRound(decimal)
      const upper = p.add(t)
      const lower = p.lt(t) ? 0 : p.sub(t)
      if (ratio.gt(upper)) {
        queue.push(s)
        expectedAsset.push(expected)
      } else if (ratio.lt(lower)) {
        lastQueue.push(s)
        lastExpectedAsset.push(expected)
      } else {
        if (trigger) {
          queue.push(s)
          expectedAsset.push(expected)
        }
      }
    })
    return {
      queue: queue.concat(lastQueue),
      limits: expectedAsset.concat(lastExpectedAsset),
    }
  }

  const verifyTrigger = function (
    result,
    expectedStrategiesArray,
    expectedLimitArray,
  ) {
    const queue = result[0]
    const limits = result[1]
    queue.forEach((item, i) => {
      expect(item).to.be.equal(expectedStrategiesArray[i])
    })
    limits.forEach((item, i) => {
      expect(item).to.be.a.bignumber.equal(expectedLimitArray[i])
    })
    expect(queue.length).to.be.equal(expectedStrategiesArray.length)
    return expect(limits.length).to.be.equal(expectedLimitArray.length)
  }

  const initStrategies = async function (
    strategies,
    estimatedTotalAssets,
    triggers,
    percents,
    thresholds,
  ) {
    // let promises = []
    // strategies.forEach((s, i) => {
    //     promises.push(daiAdaptor
    //       .setStrategyConfig(s.address, zero, percents[i], thresholds[i], { from: governance }));
    //     promises.push(s.setEstimatedAmount(estimatedTotalAssets[i]));
    //     promises.push(s.setWorthHarvest(triggers[i]));
    // })
    // await Promise.all(promises);
  }

  describe('set functions', function () {
    it('setVaultReserve revert without owner', async () => {
      return expect(daiAdaptor.setVaultReserve(100, { from: investor1 })).to.eventually.be.rejectedWith('caller is not the owner');
    })

    it('setVaultReserve revert with big reserve', async () => {
      return expect(daiAdaptor.setVaultReserve(10001)).to.eventually.be.rejected;
    })

    it('setStrategyDebtRatioBuffer revert without owner', async () => {
      return expect(daiAdaptor.setStrategyDebtRatioBuffer(0, { from: investor1 })).to.eventually.be.rejectedWith('caller is not the owner');
    })

    it('setOpenHarvest revert without owner', async () => {
      return expect(daiAdaptor.setOpenHarvest(true, { from: investor1 })).to.eventually.be.rejectedWith('caller is not the owner');
    })

    it('setGasBounty revert without owner', async () => {
      return expect(daiAdaptor.setGasBounty(100, { from: investor1 })).to.eventually.be.rejectedWith('caller is not the owner');
    })
  })

  describe('withdraw', function () {
    beforeEach(async function () {
      await mockController.setLifeGuard(investor1);
      const amount = toBN(1000).mul(daiBaseNum);
      await mockDAI.mint(investor1, amount);
      await mockDAI.approve(daiAdaptor.address, amount, { from: investor1 });
      await daiAdaptor.deposit(amount, { from: investor1 });
      await daiAdaptor.addToWhitelist(governance, {from: governance});
    });

    it('withdraw recipient revert !insurance', async () => {
      return expect(daiAdaptor.withdraw(0, investor1)).to.eventually.be.rejectedWith('withdraw: !insurance');
    })

    it('withdraw recipient from adaptor', async () => {
      const amount = toBN(1000).mul(daiBaseNum);
      await mockController.setInsurance(investor1);
      await daiAdaptor.withdraw(amount, investor2, { from: investor1 });
      await expect(mockDAI.balanceOf(investor2)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('withdraw to recipient from strategy', async () => {
      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });

      const amount = toBN(100).mul(daiBaseNum);
      const totalAssets = await daiAdaptor.totalAssets();

      await mockController.setInsurance(investor1);
      await daiAdaptor.withdraw(amount, investor2, { from: investor1 });

      await expect(mockDAI.balanceOf(investor2)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(totalAssets.sub(amount));
    })

    it('withdraw revert !lifeguard', async () => {
      return expect(daiAdaptor.methods['withdraw(uint256)'](0)).to.eventually.be.rejectedWith('withdraw: !lifeguard');
    })

    it('withdraw from adaptor', async () => {
      const amount = toBN(1000).mul(daiBaseNum);
      await mockController.setInsurance(investor1);
      await daiAdaptor.methods['withdraw(uint256)'](amount, { from: investor1 });
      await expect(mockDAI.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('withdraw from strategy', async () => {
      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });

      const amount = toBN(100).mul(daiBaseNum);
      const totalAssets = await daiAdaptor.totalAssets();

      await mockController.setInsurance(investor1);
      await daiAdaptor.methods['withdraw(uint256)'](amount, { from: investor1 });

      await expect(mockDAI.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(totalAssets.sub(amount));
    })

    it('withdrawByStrategyOrder revert !withdrawHandler|insurance|emergencyHandler', async () => {
      return expect(daiAdaptor.withdrawByStrategyOrder(0, investor1, false)).to.eventually.be.rejectedWith('withdraw: !withdrawHandler|insurance|emergencyHandler');
    })

    it('withdrawByStrategyOrder ok withdrawHandler|insurance|emergencyHandler', async () => {
      const amount = toBN(100).mul(daiBaseNum);
      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor1, false, { from: investor1 });
      await mockController.setWithdrawHandler(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor1, false, { from: investor1 });
      await mockController.setEmergencyHandler(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor1, false, { from: investor1 });
      return;
    })

    it('withdrawByStrategyOrder from adaptor', async () => {
      const amount = toBN(1000).mul(daiBaseNum);
      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor1, false, { from: investor1 });
      await expect(mockDAI.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('withdrawByStrategyOrder from strategy', async () => {
      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });

      const amount = toBN(100).mul(daiBaseNum);
      const totalAssets = await daiAdaptor.totalAssets();
      const s0Assets = await daiAdaptor.getStrategyAssets(0);
      const s1Assets = await daiAdaptor.getStrategyAssets(1);

      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor2, false, { from: investor1 });

      await expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(totalAssets.sub(amount));
      await expect(daiAdaptor.getStrategyAssets(0)).to.eventually.be.a.bignumber.equal(s0Assets.sub(amount));
      await expect(daiAdaptor.getStrategyAssets(1)).to.eventually.be.a.bignumber.equal(s1Assets);
      return expect(mockDAI.balanceOf(investor2)).to.eventually.be.a.bignumber.equal(amount);
    })

    it('withdrawByStrategyOrder from strategy with reversed ', async () => {
      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });

      const amount = toBN(100).mul(daiBaseNum);
      const totalAssets = await daiAdaptor.totalAssets();
      const s0Assets = await daiAdaptor.getStrategyAssets(0);
      const s1Assets = await daiAdaptor.getStrategyAssets(1);

      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyOrder(amount, investor2, true, { from: investor1 });

      await expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(totalAssets.sub(amount));
      await expect(daiAdaptor.getStrategyAssets(0)).to.eventually.be.a.bignumber.equal(s0Assets);
      await expect(daiAdaptor.getStrategyAssets(1)).to.eventually.be.a.bignumber.equal(s1Assets.sub(amount));
      return expect(mockDAI.balanceOf(investor2)).to.eventually.be.a.bignumber.equal(amount);
    })

    it('withdrawByStrategyOrder revert !insurance', async () => {
      return expect(daiAdaptor.withdrawByStrategyIndex(0, investor1, 0)).to.eventually.be.rejectedWith('withdraw: !insurance');
    })

    it('withdrawByStrategyIndex from adaptor', async () => {
      const amount = toBN(1000).mul(daiBaseNum);
      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyIndex(amount, investor1, 0, { from: investor1 });
      await expect(mockDAI.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(amount);
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('withdrawByStrategyIndex from strategy 1', async () => {
      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });

      const amount = toBN(100).mul(daiBaseNum);
      const totalAssets = await daiAdaptor.totalAssets();
      const s0Assets = await daiAdaptor.getStrategyAssets(0);
      const s1Assets = await daiAdaptor.getStrategyAssets(1);

      await mockController.setInsurance(investor1);
      await daiAdaptor.withdrawByStrategyIndex(amount, investor2, 1, { from: investor1 });

      await expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(totalAssets.sub(amount));
      await expect(daiAdaptor.getStrategyAssets(0)).to.eventually.be.a.bignumber.equal(s0Assets);
      await expect(daiAdaptor.getStrategyAssets(1)).to.eventually.be.a.bignumber.equal(s1Assets.sub(amount));
      return expect(mockDAI.balanceOf(investor2)).to.eventually.be.a.bignumber.equal(amount);
    })

    it('migrate revert !owner', async () => {
      return expect(daiAdaptor.migrate(investor1, { from: investor1 })).to.eventually.be.rejectedWith('caller is not the owner');
    })

    it('migrate revert 0x', async () => {
      return expect(daiAdaptor.migrate(constants.ZERO_ADDRESS, {from: governance})).to.eventually.be.rejectedWith('migrate: child == 0x');
    })

    it("Should be possible to migrate to a new vault", async function () {
      const newAdaptor = await VaultAdaptor.new(mockDAI.address);
      await expect(mockDAI.balanceOf(daiAdaptor.address)).to.eventually.be.a.bignumber.greaterThan(toBN(0));
      await expect(mockDAI.balanceOf(newAdaptor.address)).to.eventually.be.a.bignumber.equal(toBN(0));
      await daiAdaptor.migrate(newAdaptor.address, {from: governance});
      await expect(mockDAI.balanceOf(daiAdaptor.address)).to.eventually.be.a.bignumber.equal(toBN(0));
      await expect(mockDAI.balanceOf(newAdaptor.address)).to.eventually.be.a.bignumber.greaterThan(toBN(0));
    })
  });

  describe('deposit', function () {
    it('revert !lifeguard', async () => {
      return expect(daiAdaptor.deposit(0)).to.eventually.be.rejectedWith('deposit: !lifeguard');
    })

    it('ok', async () => {
      const amount = toBN(1000).mul(daiBaseNum);
      await mockController.setLifeGuard(investor1);
      await mockDAI.mint(investor1, amount);
      await mockDAI.approve(daiAdaptor.address, amount, { from: investor1 });
      await daiAdaptor.deposit(amount, { from: investor1 });
      await expect(mockDAI.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(toBN(0));
      return expect(daiAdaptor.totalAssets()).to.eventually.be.a.bignumber.equal(amount);
    })
  });

  describe("harvest", function () {
    beforeEach(async function () {
      await mockController.setLifeGuard(investor1);
      const amount = toBN(1000).mul(daiBaseNum);
      await mockDAI.mint(investor1, amount);
      await mockDAI.approve(daiAdaptor.address, amount, { from: investor1 });
      await daiAdaptor.deposit(amount, { from: investor1 });
      await daiAdaptor.addToWhitelist(governance, { from: governance });

      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });
    });

    it("strategyHarvestTrigger revert when index > strategyLength", async function () {
      return expect(daiAdaptor.strategyHarvestTrigger(2, 0)).to.eventually.be.rejectedWith('invalid index');
    })

    it("strategyHarvestTrigger false without profit", async function () {
      const result = await daiAdaptor.strategyHarvestTrigger(0, 0);
      return expect(result).equal(false);
    })

    it("strategyHarvestTrigger true with profit", async function () {
      const profit = toBN(100).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit);
      const result = await daiAdaptor.strategyHarvestTrigger(0, 0);
      return expect(result).equal(true);
    })

    it("strategyHarvestTrigger false with profit and big callcost", async function () {
      const profit = toBN(100).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit);
      const result = await daiAdaptor.strategyHarvestTrigger(0, profit);
      return expect(result).equal(false);
    })

    it("strategyHarvestTrigger true with loss", async function () {
      const loss = toBN(100).mul(daiBaseNum);
      await mockDAI.burn(primaryStrategy.address, loss);
      const result = await daiAdaptor.strategyHarvestTrigger(0, loss);
      return expect(result).equal(true);
    })

    it('strategyHarvest revert index > strategyLength', async () => {
      return expect(daiAdaptor.strategyHarvest(2, { from: governance })).to.eventually.be.rejectedWith('invalid index');
    })

    it('strategyHarvest revert !Whitelist', async () => {
      return expect(daiAdaptor.strategyHarvest(0)).to.eventually.be.rejectedWith('StrategyHarvest: !whitelist');
    })

    it("strategyHarvest with profit", async function () {
      const profit = toBN(100).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit);
      await daiAdaptor.strategyHarvest(0, { from: governance });
      return;
    })

    it.skip("strategyHarvest with profit and gasBounty", async function () {
      let result = await daiVault.strategies(primaryStrategy.address);
      console.log(`s0.debtRatio: ${result.debtRatio}, s0.totalDebt: ${result.totalDebt}`);
      result = await daiVault.strategies(secondaryStrategy.address);
      console.log(`s1.debtRatio: ${result.debtRatio}, s1.totalDebt: ${result.totalDebt}`);

      const gasBounty = toBN(100);
      //await daiAdaptor.setGasBounty(gasBounty);
      const profit = toBN(200).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit);

      console.log('daiVault totalAssets: ' + await daiVault.totalAssets());

      await daiAdaptor.strategyHarvest(0, { from: governance });

      result = await daiVault.strategies(primaryStrategy.address);
      console.log(`s0.debtRatio: ${result.debtRatio}, s0.totalDebt: ${result.totalDebt}`);
      result = await daiVault.strategies(secondaryStrategy.address);
      console.log(`s1.debtRatio: ${result.debtRatio}, s1.totalDebt: ${result.totalDebt}`);
      console.log('daiVault totalAssets: ' + await daiVault.totalAssets());
      console.log('daiVault balance: ' + await mockDAI.balanceOf(daiVault.address));

      //return expect(mockDAI.balanceOf(governance)).to.eventually.be.bignumber.equal(profit.mul(gasBounty).div(constants.PERCENT_FACTOR));
    })

    it("strategyHarvest with loss", async function () {
      const loss = toBN(100).mul(daiBaseNum);
      await mockDAI.burn(primaryStrategy.address, loss);
      await daiAdaptor.strategyHarvest(0, { from: governance });
      return;
    })

    it("strategyHarvest with openHarvest", async function () {
      await daiAdaptor.setOpenHarvest(true, {from: governance});
      const profit = toBN(100).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit);
      await daiAdaptor.strategyHarvest(0, {from: governance});
      return;
    })
  })

  describe("withdrawToAdapter", function () {
    beforeEach(async function () {
      await mockController.setLifeGuard(investor1);
      const amount = toBN(1000).mul(daiBaseNum);
      await mockDAI.mint(investor1, amount);
      await mockDAI.approve(daiAdaptor.address, amount, { from: investor1 });
      await daiAdaptor.deposit(amount, { from: investor1 });
      await daiAdaptor.addToWhitelist(governance, {from: governance});

      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });
    });

    it("revert !Whitelist", async function () {
      const amount = toBN(1000).mul(daiBaseNum);
      return expect(daiAdaptor.withdrawToAdapter(amount, 0)).to.eventually.be.rejectedWith('only whitelist');
    })
  })

  describe("totalEstimatedAssets", function () {
    beforeEach(async function () {
      await mockController.setLifeGuard(investor1);
      const amount = toBN(1000).mul(daiBaseNum);
      await mockDAI.mint(investor1, amount);
      await mockDAI.approve(daiAdaptor.address, amount, { from: investor1 });
      await daiAdaptor.deposit(amount, { from: investor1 });
      await daiAdaptor.addToWhitelist(governance, {from: governance});

      await daiAdaptor.strategyHarvest(0, { from: governance });
      await daiAdaptor.strategyHarvest(1, { from: governance });
    });

    it("ok", async function () {
      const amount = await daiAdaptor.totalAssets();

      const profit1 = toBN(100).mul(daiBaseNum);
      await mockDAI.mint(primaryStrategy.address, profit1);
      const profit2 = toBN(200).mul(daiBaseNum);
      await mockDAI.mint(secondaryStrategy.address, profit2);
      const result = await daiAdaptor.totalEstimatedAssets();
      console.log('result: ' + result);

      return expect(result).to.be.bignumber.equal(amount.add(profit1).add(profit2));
    })
  })

  describe("setStrategyDebtRatio", function () {
    it('revert !owner|insurance', async () => {
      return expect(daiAdaptor.setStrategyDebtRatio([0, 0], { from: investor2 })).to.eventually.be.rejectedWith('!setStrategyDebtRatio: !owner|insurance');
    })

    it('revert ratios > 100%', async () => {
      return expect(daiAdaptor.setStrategyDebtRatio([6000, 5000], {from: governance})).to.eventually.be.rejectedWith('updateStrategyDebtRatio: debtRatio > 100%');
    })

    it("ok owner|insurance", async function () {
      const s0 = toBN(8000);
      const s1 = toBN(2000);
      await daiAdaptor.setStrategyDebtRatio([s0, s1], {from: governance});
      await mockController.setInsurance(investor2);
      await daiAdaptor.setStrategyDebtRatio([s0, s1], { from: investor2 });
      return;
    })

    it("ok", async function () {
      const s0 = toBN(8000);
      const s1 = toBN(2000);
      await daiAdaptor.setStrategyDebtRatio([s0, s1], {from: governance});

      let result = await daiVault.strategies(primaryStrategy.address);
      expect(result.debtRatio).to.be.bignumber.equal(s0);
      result = await daiVault.strategies(secondaryStrategy.address);
      expect(result.debtRatio).to.be.bignumber.equal(s1);
      return;
    })
  })

  describe("Utility", function () {
      it("Should be possible to change the vault name", async function () {
          await expect(daiAdaptor.setName('NewName', {from: governance})).to.eventually.be.fulfilled;
          return expect(daiAdaptor.name()).to.eventually.be.equal('NewName');
      })

      it("Should be possible to update the withdrawal queue", async function () {
          await expect(daiAdaptor.withdrawalQueue(0)).to.eventually.not.equal(ZERO);
          await expect(daiAdaptor.withdrawalQueue(0)).to.eventually.equal(primaryStrategy.address);
          await daiAdaptor.setWithdrawalQueue([secondaryStrategy.address, primaryStrategy.address],{from: governance})
          return expect(daiAdaptor.withdrawalQueue(0)).to.eventually.be.equal(secondaryStrategy.address);
      })

      it("Should revert if new queue exceeds MAX length", async function () {
          const primAddress = primaryStrategy.address;
          const newQueue = [primAddress, primAddress, primAddress, primAddress, primAddress];
          return expect(daiAdaptor.setWithdrawalQueue(newQueue)).to.eventually.be.rejected;
      })

      it("Should return max value if the queue is full", async function () {
          const mockStratA = await TestStrategy.new(daiVault.address)
          const mockStratB = await TestStrategy.new(daiVault.address)
          await daiAdaptor.addStrategy(
            mockStratA.address,
            0,
            0, 1,
            { from: governance }
          )
          await daiAdaptor.addStrategy(
            mockStratB.address,
            0,
            0, 1,
            { from: governance }
          )
          const maxStrats = await daiAdaptor.MAXIMUM_STRATEGIES();
          return expect(daiAdaptor.getStrategiesLength()).to.eventually.be.a.bignumber.equal(maxStrats);
      })

      it("Should be able to migrate strategy", async function () {
          const mockStratA = await TestStrategy.new(daiVault.address)
          await daiAdaptor.migrateStrategy(primaryStrategy.address, mockStratA.address, {from: governance});
          return expect(daiAdaptor.withdrawalQueue(0)).to.eventually.be.equal(mockStratA.address);
      })

      it("Should be possible to get the strategyDebtRatio", async function () {
         return expect(daiAdaptor.methods['updateStrategyDebtRatio()']({from: governance})).to.eventually.be.fulfilled;
      })

      it("Should should be possible to sweep for unwanted tokens", async function () {
          const mockUsdc = await MockUSDC.new();
          await mockUsdc.mint(daiAdaptor.address, '100000');
          await expect(mockUsdc.balanceOf(governance)).to.eventually.be.a.bignumber.equal(toBN(0));
          await daiAdaptor.sweep(mockUsdc.address, governance, {from: governance})
          await expect(mockUsdc.balanceOf(governance)).to.eventually.be.a.bignumber.gt(toBN(0));
      })

      it("Should be possible to get outstanding debt from a strategy", async function () {
          const debt = await daiAdaptor.debtOutstanding(primaryStrategy.address);
          console.log('debt: ' + debt);
      })

      it("Should be possible to get expected return", async function () {
          const debt = await daiAdaptor.expectedReturn(primaryStrategy.address);
          console.log('debt: ' + debt);
      })

      // Number can only safely store up to 53 bits
      it.skip("Should be possible to get credit available for a strategy", async function () {
          let credit = toBN(await daiAdaptor.creditAvailable(primaryStrategy.address));
          console.log('debt: ' + credit.toString());
          await mockDAI.mint(daiAdaptor, toBN(1E18).mul(toBN(10000)))
          credit = toBN(await daiAdaptor.creditAvailable(primaryStrategy.address));
          console.log('debt: ' + credit.toString());
      })

      it("Should be possible to update strategy harvest debt threshold", async function () {
          const stratData = await daiAdaptor.strategies(primaryStrategy.address);
          await daiAdaptor.updateStrategyMinDebtPerHarvest(primaryStrategy.address, 1, {from: governance});
          await daiAdaptor.updateStrategyMaxDebtPerHarvest(primaryStrategy.address, 2, {from: governance});
          console.log(stratData)
      })


      it("Should be possible to revokeStrategy", async function () {
          const stratData = await daiAdaptor.strategies(primaryStrategy.address);
          await expect(toBN(stratData.debtRatio)).to.be.a.bignumber.gt(toBN(0));
          await daiAdaptor.methods['revokeStrategy(address)'](primaryStrategy.address, {from: governance});
          const stratDataPost = await daiAdaptor.strategies(primaryStrategy.address);
          await expect(toBN(stratDataPost.debtRatio)).to.be.a.bignumber.equal(toBN(0));
      })


      it("Should be possible to add and remove StrategyFrom the queue", async function () {
          await expect(daiAdaptor.withdrawalQueue(0)).to.eventually.equal(primaryStrategy.address);
          await expect(daiAdaptor.removeStrategyFromQueue(primaryStrategy.address, {from:governance})).to.be.fulfilled;
          await expect(daiAdaptor.withdrawalQueue(0)).to.eventually.not.equal(primaryStrategy.address);
          await expect(daiAdaptor.withdrawalQueue(1)).to.eventually.equal(ZERO);
          await expect(daiAdaptor.addStrategyToQueue(primaryStrategy.address, {from:governance})).to.be.fulfilled;
          return expect(daiAdaptor.withdrawalQueue(1)).to.eventually.equal(primaryStrategy.address);
      })
  })
})
