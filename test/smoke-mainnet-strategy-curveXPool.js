const { BN, toBN, toWei } = require('web3-utils');
const { expect, asyncForEach } = require('../utils/common-utils')
const { advanceSpecialBlock } = require('../utils/contract-web3-utils');
const fs = require('fs');
const { newController } = require('../utils/factory/controller')
const xPool = artifacts.require('StableYearnXPool')

const {
  stableCoinsRatios,
  showRebalanceTriggerResult,
  getSystemAssetsInfo,
  getUserAssets,
  printSystemAsset,
  printUserAssets,
} = require('../utils/common-utils')
const { mintToken } = require('../utils/token-utils')

const mainnet = true;

const daiPercent = stableCoinsRatios.daiRatio,
  usdcPercent = stableCoinsRatios.usdcRatio,
  usdtPercent = stableCoinsRatios.usdtRatio,
  percentFactor = toBN(10000),
  gvtPrice = toBN(300),
  baseNum = toBN(1e18),
  gvtInitBase = baseNum.div(gvtPrice),
  zero = toBN(0)
let controller,
  insurance,
  exposure,
  allocation,
  pnl,
  gvt,
  pwrd,
  daiBaseNum,
  usdcBaseNum,
  usdtBaseNum,
  lpBaseNum,
  mockDAI,
  mockUSDC,
  mockUSDT,
  DAIVaultAdaptor,
  USDCVaultAdaptor,
  USDTVaultAdaptor,
  mockCurveVault,
  mockCurveStrategy,
  pool,
  lifeguard,
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
    bank = '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7';
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [bank],

    });

    controller = await newController(mainnet)
      ;[mockDAI, mockUSDC, mockUSDT] = controller.underlyingTokens
    gvt = controller.gvt
    pwrd = controller.pwrd
    pnl = controller.pnl
    lifeguard = controller.lifeguard
    lpt = lifeguard.lpt
    insurance = controller.insurance
    exposure = insurance.exposure
    allocation = insurance.allocation
      ;[DAIVaultAdaptor, USDCVaultAdaptor, USDTVaultAdaptor, CurveVaultAdaptor] = controller.vaults
      ;[mockDAIVault, mockUSDCVault, mockUSDTVault, mockCurveVault] = [
        DAIVaultAdaptor.vault,
        USDCVaultAdaptor.vault,
        USDTVaultAdaptor.vault,
        CurveVaultAdaptor.vault,
      ]
      ;[
        mockDAIHarvestStrategy,
        mockDAIGenericStrategy,
      ] = DAIVaultAdaptor.strategies
      ;[
        mockUSDCHarvestStrategy,
        mockUSDCGenericStrategy,
      ] = USDCVaultAdaptor.strategies
      ;[
        mockUSDTHarvestStrategy,
        mockUSDTGenericStrategy,
      ] = USDTVaultAdaptor.strategies
      ;[
        mockCurveStrategy,
      ] = CurveVaultAdaptor.strategies

    await mockDAIVault.updateStrategyDebtRatio(mockDAIGenericStrategy.address, '0');
    await insurance.batchSetUnderlyingTokensPercents([
      daiPercent,
      usdcPercent,
      usdtPercent,
    ])

    daiBaseNum = new BN(10).pow(mockDAI.detailed.decimals)
    usdcBaseNum = new BN(10).pow(mockUSDC.detailed.decimals)
    usdtBaseNum = new BN(10).pow(mockUSDT.detailed.decimals)

    // await gvt.setInitBase(gvtInitBase);

    const mintAmount = new BN(200000);
    await mintToken(mockDAI, investor1, mintAmount.mul(daiBaseNum), mainnet);
    await mintToken(mockUSDC, investor1, mintAmount.mul(usdcBaseNum), mainnet);
    await mintToken(mockUSDT, investor1, mintAmount.mul(usdtBaseNum), mainnet);

    await mintToken(mockDAI, investor1, mintAmount.mul(daiBaseNum), mainnet);
    await mintToken(mockUSDC, investor1, mintAmount.mul(usdcBaseNum), mainnet);
    await mintToken(mockUSDT, investor1, mintAmount.mul(usdtBaseNum), mainnet);

    // 5000 usd : whale deposit
    //await lifeguard.updateThreshold(threshold, { from: governance })
    // 1000 usd : lifeguard's buffer, mapping to 25000 usd total assetd
    //await lifeguard.updateBuffer(buffer, { from: governance })
    // 500 usd : lifeguard's buffer threshold
    //await lifeguard.updateBufferThreshold(bufferThreshold, { from: governance })

    // add protocols to system
    pool = lifeguard.pool
    curve = pool.address

    await exposure.setProtocolCount(2)

    controller.setReward(reward)
    await controller.setBigFishThreshold(1000, toBN(200).mul(daiBaseNum));
    const deposit0 = [
      toBN(50).mul(daiBaseNum),
      toBN(50).mul(usdcBaseNum),
      toBN(50).mul(usdtBaseNum),
    ]

    await controller.depositGvt(
      deposit0,
      investor1,
    )
    await controller.depositGvt(
      deposit0,
      investor1,
    )

    await insurance.setWhaleThresholdDeposit(2000);
    await controller.setBigFishThreshold(1, 100);
    await insurance.setCurveVaultPercent(1000);
    const deposit1 = [
      toBN(3000).mul(daiBaseNum),
      toBN(3000).mul(usdcBaseNum),
      toBN(3000).mul(usdtBaseNum),
    ]
    let [usd, usdWithSlippage] = await controller.depositGvt(
      deposit1,
      investor1,
    )
    await lifeguard.investToCurveVault();
    let postSystemAssetState = await getSystemAssetsInfo(controller)
    let postUserAssetState = await getUserAssets(controller, investor1)

    // initiate
    yVault = new web3.eth.Contract(yVaultABI, yVaultAddress);
    metaCurve = new web3.eth.Contract(curveABI, metaCurveAddress);
    metaZap = new web3.eth.Contract(zapABI, metaZapAddress);
    metaLpt = new web3.eth.Contract(lptABI, metaLptAddress);

    await mockCurveStrategy.setMetaPool(yVaultAddress, metaCurveAddress)
    await mockCurveStrategy.forceTend();
    await mockCurveStrategy.tend();
  });

  describe('Strategy integration', function () {
    beforeEach(async function () {
    });

    it('Should always return false when calling harvest trigger, if costs outweight gains', async () => {
      return expect(CurveVaultAdaptor.strategyHarvestTrigger(0, new BN("1000").mul(baseNum))).to.eventually.equal(false);
    })

    it('Should always return true when calling harvest trigger, if gains outweigh costs', async () => {
      return expect(CurveVaultAdaptor.strategyHarvestTrigger(0, new BN("1000"))).to.eventually.equal(true);
    })

    it('Should be possible to invest assets into strategy', async () => {
      const initialLpt = new BN(await lpt.balanceOf(mockCurveVault.address));
      await expect(CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })).to.be.fulfilled;

      const postHarvestLpt = new BN(await lpt.balanceOf(CurveVaultAdaptor.address));

      const expected = new BN(toWei('885', 'ether')); // 10000 - 5000
      const actual = initialLpt.sub(postHarvestLpt)
      return expect(actual).to.be.bignumber.closeTo(expected, new BN(5).mul(baseNum));
    });

    it('Should not hold more assets than assigned debt ratio', async () => {
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const stratExpectedUpper = toWei('890', 'ether').toString();
      const stratExpectedLower = toWei('880', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address);
      const actual = await mockCurveStrategy.estimatedTotalAssets();
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      return expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
    })

    it('Should be able to change total amount assets in strategy', async () => {
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const initVaultLpt = await lpt.balanceOf(mockCurveVault.address);
      await mockCurveVault.updateStrategyDebtRatio(mockCurveStrategy.address, '7500');

      const stratInfo = await mockCurveVault.strategies(mockCurveStrategy.address);
      assert.strictEqual(stratInfo[1].toString(), '7500');

      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const stratExpectedUpper = toWei('665', 'ether').toString();
      const stratExpectedLower = toWei('660', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address);
      const actual = await mockCurveStrategy.estimatedTotalAssets();
      const vaultLpt = await lpt.balanceOf(mockCurveVault.address);
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
      // large loss of assets as we withdraw
      // we end up with a bit of remaining debt, as the withdrawal logic uses estimates
      // from the curve pool (calc_token_amount)
      return expect(vaultLpt).to.be.bignumber.greaterThan(initVaultLpt);
    })

    it('Should pull out all assets if an emergency exist has been triggered', async () => {
      const initialLpt = await lpt.balanceOf(mockCurveVault.address);
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const stratExpectedUpper = toWei('890', 'ether').toString();
      const stratExpectedLower = toWei('880', 'ether').toString();
      const stratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address);
      const actual = await mockCurveStrategy.estimatedTotalAssets();
      const vaultLpt = await lpt.balanceOf(mockCurveVault.address);

      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
      await expect(vaultLpt).to.be.bignumber.equal(new BN('0'));

      await mockCurveStrategy.setEmergencyExit();
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const finalStratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      const finalStratMetaLpt = await metaLpt.methods.balanceOf(mockCurveStrategy.address).call();
      const finalVaultLpt = await lpt.balanceOf(mockCurveVault.address);
      const finalVaultMetaLpt = await metaLpt.methods.balanceOf(mockCurveVault.address).call();

      await expect(finalStratYAssets).to.be.bignumber.equal(new BN("0"));
      await expect(finalVaultLpt).to.be.bignumber.lt(initialLpt);
      return expect(finalVaultLpt)
        .to.be.bignumber.gt(initialLpt.mul(new BN("9999").div(new BN("10000"))));
    });

    it('Should be possible to migrate strategy', async () => {
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })
      const stratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      await expect(stratYAssets).to.be.a.bignumber.gt(new BN("0"));

      const newmockCurveStrategy = await xPool.new(mockCurveVault.address);
      await newmockCurveStrategy.setKeeper(CurveVaultAdaptor.address);
      await newmockCurveStrategy.setMetaPool(yVaultAddress, metaCurveAddress)
      await newmockCurveStrategy.forceTend();
      await newmockCurveStrategy.tend();

      await mockCurveStrategy.migrate(newmockCurveStrategy.address);
      await mockCurveVault.revokeStrategy(mockCurveStrategy.address);
      await mockCurveVault.removeStrategyFromQueue(mockCurveStrategy.address);


      const botLimit = toBN(0)
      const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));
      const performanceFee = toBN(100);
      await mockCurveVault.addStrategy(
        newmockCurveStrategy.address,
        10000,
        botLimit, topLimit,
        { from: governance },
      )
      const newVaultStrategy = await mockCurveVault.withdrawalQueue(0);
      assert.strictEqual(newVaultStrategy, newmockCurveStrategy.address);
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })

      const oldStratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      const newStratYAssets = await yVault.methods.balanceOf(newmockCurveStrategy.address).call();
      const oldLpMAssets = await metaLpt.methods.balanceOf(mockCurveStrategy.address).call()
      const newLpMAssets = await metaLpt.methods.balanceOf(newmockCurveStrategy.address).call()

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
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })
      const stratYAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      await mockCurveStrategy.setMetaPool(newYVault, newmetaCurve);
      const preMigAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      await mockCurveStrategy.forceTend();
      await mockCurveStrategy.tend();
      const postMigNewAssets = await yVaultNew.methods.balanceOf(mockCurveStrategy.address).call();
      const postMigOldAssets = await yVault.methods.balanceOf(mockCurveStrategy.address).call();
      const postMigLptOldAssets = await lpt.balanceOf(mockCurveStrategy.address);
      const postMigLptNewAssets = await lptNew.methods.balanceOf(mockCurveStrategy.address).call();
      const actual = await mockCurveStrategy.estimatedTotalAssets();
      await expect(postMigOldAssets).to.be.a.bignumber.equal(new BN("0"));
      await expect(actual).to.be.bignumber.lt(new BN(stratExpectedUpper));
      return await expect(actual).to.be.bignumber.gt(new BN(stratExpectedLower));
    });

    it('Should correctly calculate generated profits from swapping fees', async () => {
      await CurveVaultAdaptor.strategyHarvest(0, { from: accounts[0] })
      await expect(mockCurveStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(new BN("0"));
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
      return expect(mockCurveStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(new BN("0"));
    });
  });
});
