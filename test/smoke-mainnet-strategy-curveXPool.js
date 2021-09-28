require('dotenv').config();
const MockController = artifacts.require('MockController')
const MockInsurance = artifacts.require('MockInsurance')
const MockPnL = artifacts.require('MockPnL')
const MockERC20 = artifacts.require('MockERC20')
const TestStrategy = artifacts.require('TestStrategy')
const xPool = artifacts.require('StableYearnXPool')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')

const { BN, toBN, toWei } = require('web3-utils');
const { advanceSpecialBlock } = require('./utils/contract-web3-utils');
const { constants } = require('./utils/constants');
const { expect, asyncForEach, ZERO, tokens, setBalance, setStorageAt, toBytes32 } = require('./utils/common-utils');

const fs = require('fs');
const mainnet = true;

const percentFactor = toBN(10000),
  baseNum = toBN(1e18);

let controller,
  insurance,
  exposure,
  allocation,
  pnl,
  mockDAI,
  mockUSDC,
  mockUSDT,
  curveVaultAdapter,
  primaryStrategy,
  pool,
  curve,
  vault,
  yVault,
  lpt,
  metaLpt,
  metaCurve,
  zap;

// ABI
const yVaultABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/yVaultDaiV1.json"));
const curveABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/metaPool.json"));
const zapABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/zap.json"));
const lptABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/metaToken.json"));

// addresses on mainnet
const daiAddress = '0x6b175474e89094c44da98b954eedeac495271d0f';
const yVaultAddress = '0xC4dAf3b5e2A9e93861c3FBDd25f1e943B8D87417';
const metaCurveAddress = '0x42d7025938bEc20B69cBae5A77421082407f053A';
const metaZapAddress = '0x3c8cAee4E09296800f8D29A68Fa3837e2dae4940';
const metaLptAddress = '0x7Eb40E450b9655f4B3cC4259BCC731c63ff55ae6';

contract('Curve metapool strategy', async accounts => {
  const deployer = accounts[0],
    governance = deployer,
    investor1 = accounts[1],
    investor2 = accounts[2],
    alpha = accounts[4],
    compound = accounts[5],
    reward = accounts[9]
  beforeEach(async function () {


    // Set up stablecoins + mocks needed for the vault adapter
    lpt = await MockERC20.at(tokens.lpt.address);
    weth = await MockERC20.at(tokens.weth.address);
    mockController = await MockController.new();
    mockInsurance = await MockInsurance.new();
    mockPnL = await MockPnL.new();
    await mockController.setInsurance(mockInsurance.address);
    await mockController.setPnL(mockPnL.address);

    // create the vault adapter
    curveVaultAdapter = await VaultAdaptor.new(tokens.dai.address, { from: governance });
    await curveVaultAdapter.setController(mockController.address, { from: governance });
    await curveVaultAdapter.addToWhitelist(governance, {from: governance});

    // create and add the AHv2 strategy to the adapter
    primaryStrategy = await xPool.new(curveVaultAdapter.address);
    await primaryStrategy.setKeeper(curveVaultAdapter.address, {from: governance});
    const botLimit = toBN(0)
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    await curveVaultAdapter.addStrategy(
      primaryStrategy.address,
      10000, // set debtRatio to 100%
      botLimit, topLimit,
      { from: governance }
    )

    await setBalance('dai', investor1, '2000000');
    await setBalance('usdc', investor1, '2000000');
    await setBalance('usdt', investor1, '2000000');
    await setBalance('lpt', investor1, '2000000', 1);

    // initiate
    yVault = new web3.eth.Contract(yVaultABI, yVaultAddress);
    metaCurve = new web3.eth.Contract(curveABI, metaCurveAddress);
    metaZap = new web3.eth.Contract(zapABI, metaZapAddress);
    metaLpt = new web3.eth.Contract(lptABI, metaLptAddress);

    await primaryStrategy.setMetaPool(yVaultAddress, metaCurveAddress)
    await primaryStrategy.forceTend();
    await primaryStrategy.tend();
  });

  describe('Strategy integration', function () {
    beforeEach(async function () {
        await setBalance('lpt', curveVaultAdapter.address, '1000000', 1);
    });

    it('Should always return false when calling harvest trigger, if costs outweight gains', async () => {
      return expect(curveVaultAdapter.strategyHarvestTrigger(0, new BN("1000").mul(baseNum))).to.eventually.equal(false);
    })

    it('Should always return true when calling harvest trigger, if gains outweigh costs', async () => {
      return expect(curveVaultAdapter.strategyHarvestTrigger(0, 0)).to.eventually.equal(true);
    })

    it.only('Should be possible to invest assets into strategy', async () => {
      console.log(await lpt.balanceOf(curveVaultAdapter.address))
      await expect(lpt.balanceOf(curveVaultAdapter.address)).to.eventually.be.a.bignumber.equal(toBN('1000000').mul(toBN(1E18)));
      await expect(curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })).to.be.fulfilled;
      return expect(lpt.balanceOf(curveVaultAdapter.address)).to.be.a.bignumber.equal(0);
    });

    it.only('Should not hold more assets than assigned debt ratio', async () => {
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })
      return expect(primaryStrategy.estimatedTotalAssets()).to.be.bignumber.eq(toBN('1000000').mul(toBN(1E18)));


      const stratExpectedUpper = toWei('890', 'ether').toString();
      const stratExpectedLower = toWei('880', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(primaryStrategy.address);
      const actual = await
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
    })

    it('Should be able to change total amount assets in strategy', async () => {
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })

      const initVaultLpt = await lpt.balanceOf(curveVaultAdapter.address);
      await curveVaultAdapter.updateStrategyDebtRatio(primaryStrategy.address, '7500');

      const stratInfo = await curveVaultAdapter.strategies(primaryStrategy.address);
      assert.strictEqual(stratInfo[1].toString(), '7500');

      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })

      const stratExpectedUpper = toWei('665', 'ether').toString();
      const stratExpectedLower = toWei('660', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(primaryStrategy.address);
      const actual = await primaryStrategy.estimatedTotalAssets();
      const vaultLpt = await lpt.balanceOf(curveVaultAdapter.address);
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
      // large loss of assets as we withdraw
      // we end up with a bit of remaining debt, as the withdrawal logic uses estimates
      // from the curve pool (calc_token_amount)
      return expect(vaultLpt).to.be.bignumber.greaterThan(initVaultLpt);
    })

    it('Should pull out all assets if an emergency exist has been triggered', async () => {
      const initialLpt = await lpt.balanceOf(curveVaultAdapter.address);
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })

      const stratExpectedUpper = toWei('890', 'ether').toString();
      const stratExpectedLower = toWei('880', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(primaryStrategy.address);
      const actual = await primaryStrategy.estimatedTotalAssets();
      const vaultLpt = await lpt.balanceOf(curveVaultAdapter.address);

      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
      await expect(vaultLpt).to.be.bignumber.equal(new BN('0'));

      await primaryStrategy.setEmergencyExit();
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })

      const finalStratYAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      const finalStratMetaLpt = await metaLpt.methods.balanceOf(primaryStrategy.address).call();
      const finalVaultLpt = await lpt.balanceOf(curveVaultAdapter.address);
      const finalVaultMetaLpt = await metaLpt.methods.balanceOf(curveVaultAdapter.address).call();

      await expect(finalStratYAssets).to.be.bignumber.equal(new BN("0"));
      await expect(finalVaultLpt).to.be.bignumber.lt(initialLpt);
      return expect(finalVaultLpt)
        .to.be.bignumber.gt(initialLpt.mul(new BN("9999").div(new BN("10000"))));
    });

    it('Should be possible to migrate strategy', async () => {
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })
      const stratYAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      await expect(stratYAssets).to.be.a.bignumber.gt(new BN("0"));

      const newprimaryStrategy = await xPool.new(curveVaultAdapter.address);
      await newprimaryStrategy.setKeeper(curveVaultAdapter.address);
      await newprimaryStrategy.setMetaPool(yVaultAddress, metaCurveAddress)
      await newprimaryStrategy.forceTend();
      await newprimaryStrategy.tend();

      await primaryStrategy.migrate(newprimaryStrategy.address);
      await curveVaultAdapter.revokeStrategy(primaryStrategy.address);
      await curveVaultAdapter.removeStrategyFromQueue(primaryStrategy.address);


      const botLimit = toBN(0)
      const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));
      const performanceFee = toBN(100);
      await curveVaultAdapter.addStrategy(
        newprimaryStrategy.address,
        10000,
        botLimit, topLimit,
        { from: governance },
      )
      const newVaultStrategy = await curveVaultAdapter.withdrawalQueue(0);
      assert.strictEqual(newVaultStrategy, newprimaryStrategy.address);
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })

      const oldStratYAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      const newStratYAssets = await yVault.methods.balanceOf(newprimaryStrategy.address).call();
      const oldLpMAssets = await metaLpt.methods.balanceOf(primaryStrategy.address).call()
      const newLpMAssets = await metaLpt.methods.balanceOf(newprimaryStrategy.address).call()

      await expect(oldStratYAssets).to.be.a.bignumber.equal(new BN("0"));
      await expect(oldLpMAssets).to.be.a.bignumber.equal(new BN("0"));
      await expect(newLpMAssets).to.be.a.bignumber.equal(new BN("0"));
      return expect(newStratYAssets).to.be.a.bignumber.closeTo(stratYAssets, toBN(1E18));
    })

    it('Should be possible to migrate to a new metapool', async () => {
      const newmetaCurve = '0x0f9cb53Ebe405d49A0bbdBD291A65Ff571bC83e1';
      const newYVault = '0x3B96d491f067912D18563d56858Ba7d6EC67a6fa';
      const newLpt = '0x4f3E8F405CF5aFC05D68142F3783bDfE13811522';
      const yVaultNew = new web3.eth.Contract(yVaultABI, newYVault);
      const lptNew = new web3.eth.Contract(lptABI, newLpt);

      const stratExpectedUpper = toWei('885', 'ether').toString();
      const stratExpectedLower = toWei('880', 'ether').toString();
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })
      const stratYAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      await primaryStrategy.setMetaPool(newYVault, newmetaCurve);
      const preMigAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      await primaryStrategy.forceTend();
      await primaryStrategy.tend();
      const postMigNewAssets = await yVaultNew.methods.balanceOf(primaryStrategy.address).call();
      const postMigOldAssets = await yVault.methods.balanceOf(primaryStrategy.address).call();
      const postMigLptOldAssets = await lpt.balanceOf(primaryStrategy.address);
      const postMigLptNewAssets = await lptNew.methods.balanceOf(primaryStrategy.address).call();
      const actual = await primaryStrategy.estimatedTotalAssets();
      await expect(postMigOldAssets).to.be.a.bignumber.equal(new BN("0"));
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      return await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
    });

    it('Should correctly calculate generated profits from swapping fees', async () => {
      await curveVaultAdapter.strategyHarvest(0, { from: accounts[0] })
      await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(new BN("0"));
      const remDai = await mockDAI.balanceOf(bank);
      await mockDAI.approve(metaZapAddress, remDai, { from: bank });
      await metaZap.methods.add_liquidity(
        ["0", remDai.toString(), "0", "0"], 0,
      ).send({ from: bank, gas: "16721975", allow_revert: true });

      const bankLpt = await metaLpt.methods.balanceOf(bank).call();
      await metaLpt.methods.approve(yVaultAddress, bankLpt).send({ from: bank });
      await yVault.methods.deposit(
        bankLpt
      ).send({ from: bank, gas: "6721975", allow_revert: true });

      const bankYTokens = await yVault.methods.balanceOf(bank).call();
      await yVault.methods.withdraw(bankYTokens).send({ from: bank });
      const bankLpTokens = await metaLpt.methods.balanceOf(bank).call();
      await metaLpt.methods.approve(metaZapAddress, bankLpTokens).send({ from: bank });
      await metaZap.methods.remove_liquidity(bankLpTokens.toString(), ["0", "0", "0", "0"]).send({ from: bank });
      return expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(new BN("0"));
    });
  });
});
