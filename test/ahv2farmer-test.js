require('dotenv').config();
const MockController = artifacts.require('MockController')
const MockInsurance = artifacts.require('MockInsurance')
const MockPnL = artifacts.require('MockPnL')
const MockERC20 = artifacts.require('MockERC20')
const TestStrategy = artifacts.require('TestStrategy')
const AHStrategy = artifacts.require('AHv2Farmer')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')

const { toBN, BN, toWei } = web3.utils
const { constants } = require('./utils/constants');
const { expect, ZERO, tokens, setBalance, setStorageAt, toBytes32 } = require('./utils/common-utils');
const fs = require('fs');

const abiDecoder = require('abi-decoder');

const sushiSpell =  '0xDc9c7A2Bae15dD89271ae5701a6f4DB147BAa44C'
const router = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
const pool = '0xC3D03e4F041Fd4cD388c549Ee2A29a9E5075882f'
const AHGov = '0xb593d82d53e2c187dc49673709a6e9f806cdc835'
const poolID = 2; // Master chef pool id

const proxyHomora = '0xba5ebaf3fc1fcca67147050bf80462393814e54b'
const sushiToken = '0x6b3595068778dd592e39a122f4f5a5cf09c90fe2'
const chef = '0xc2EdaD668740f1aA35E4D8f227fB8E17dcA888Cd'

const homoraABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/homora.json"));
const spellSushiABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/sushiSpell.json"));
const masterChefABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/MasterChef.json"));
const uniABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/IUni.json"));

let daiAdaptor,
    mockController,
    mockInsurance,
    mockPnL,
    dai,
    weth,
    sushi,
    daiVault,
    primaryStrategy,
    secondaryStrategy,
    homoraBank,
    spellSushi,
    sushiSwapRouter,
    masterChef,
    admin,
    governance,
    investor1,
    investor2;

contract('Alpha homora test', function (accounts) {
  admin = accounts[0]
  governance = accounts[1]
  investor1 = accounts[8]
  investor2 = accounts[9]
  amount = new BN(10000)

  // Do a swap against a uni/sushi pool to simulate price changes
  async function swap(amount, path) {
      const deadline = (await web3.eth.getBlockNumber().then(res => web3.eth.getBlock(res))).timestamp
      const change = await sushiSwapRouter.methods.getAmountsOut(amount, path).call();
      await sushiSwapRouter.methods.swapExactTokensForTokens(
          change[0],
          change[1],
          path,
          investor1,
          deadline + 1000
      ).send({from: investor1});
  }


  async function snapshotChain() {
      return await network.provider.request(
          {
              method: "evm_snapshot",
              params: []
          });
  }

  async function revertChain(snapshotId) {
      await network.provider.request(
          {
              method: "evm_revert",
              params: [snapshotId]
          });
  }

  beforeEach(async function () {

    // Set up the base contracts
    homoraBank = await new web3.eth.Contract(homoraABI, proxyHomora);
    spellSushi = await new web3.eth.Contract(spellSushiABI, sushiSpell);
    masterChef = await new web3.eth.Contract(masterChefABI, chef);
    sushiSwapRouter = await new web3.eth.Contract(uniABI, router);

    // Impersonate AH governance so that we an add this strategy to the whitelist
    await hre.network.provider.request(
        {
            method: "hardhat_impersonateAccount",
            params: [AHGov]
        }
    )

    // Set up stablecoins + mocks needed for the vault adapter
    dai = await MockERC20.at(tokens.dai.address);
    weth = await MockERC20.at(tokens.weth.address);
    sushi = await MockERC20.at(sushiToken);
    mockController = await MockController.new();
    mockInsurance = await MockInsurance.new();
    mockPnL = await MockPnL.new();
    await mockController.setInsurance(mockInsurance.address);
    await mockController.setPnL(mockPnL.address);

    // create the vault adapter
    daiAdaptor = await VaultAdaptor.new(tokens.dai.address, { from: governance });
    daiVault = daiAdaptor;
    await daiAdaptor.setController(mockController.address, { from: governance });

    // create and add the AHv2 strategy to the adapter
    primaryStrategy = await AHStrategy.new(daiVault.address, sushiSpell, router, pool, poolID);
    await primaryStrategy.setKeeper(daiAdaptor.address, {from: governance});
    const botLimit = toBN(0)
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    await daiVault.addStrategy(
      primaryStrategy.address,
      10000, // set debtRatio to 100%
      botLimit, topLimit,
      { from: governance }
    )

    // add a secondary dummy strategy, potentially not necessary but we have done
    // all modelling with the assumption that we have 2 strategies per vault min.
    secondaryStrategy = await TestStrategy.new(daiVault.address)
    await secondaryStrategy.setKeeper(daiAdaptor.address, {from: governance});
    await daiVault.addStrategy(
      secondaryStrategy.address,
      0,
      botLimit, topLimit,
      { from: governance }
    )

    // add strategy to whitelist in homorabank and gov to whitelist in adapter so they can call harvest
    await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov})
    await daiAdaptor.addToWhitelist(governance, {from: governance});
    for (let i = 0; i < 10; i++) {
      await network.provider.send("evm_mine");
    }
  })

  // The strategy needs to be able to open positions in AHv2
  describe("Opening position", function () {
    beforeEach(async function () {
        // give that adapor 1M
        await setBalance('dai', daiAdaptor.address, '1000000');
    })

    // Given an investment of 1M dai, the strategy should open up a market neutral position
    // (2x) leverage of dai/eth in sushiswap through alpha homora
    it('Should be possible to open up a position in AHv2', async () => {
        // We dont have a position
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        await daiAdaptor.strategyHarvest(0, {from: governance})
        // We do have a position
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        // We are the owner of the position
        assert.strictEqual(alphaData['owner'], primaryStrategy.address);
        // TOOD check size of position
    })

    // Check that we can add assets to a position
    it('Should be possible to add to a position', async () => {
        await daiAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add 1 M dai to adaper
        await setBalance('dai', daiAdaptor.address, '1000000');
        // run harvest
        await expect(daiAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.fulfilled;
        // we should have the same position
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })
  })

  // Given an existing positon, it should be possible to close it at will, or through calling
  // harvest/tend, given a specific set of circumstances.
  describe('Closing position', function () {
    beforeEach(async function () {
        await setBalance('dai', primaryStrategy.address, '10000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
    })

    it('Should be possible to force close a position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        // There should be a position with debt and collateral
        assert.isAbove(Number(alphaDebt['debts'][0]), 0);
        assert.isAbove(Number(alphaData['collateralSize']), 0);

        // force close the position
        await primaryStrategy.panicClose(position, {from: governance});
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // position should have no debt or collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should close the position if the price has diviated with more than 5%', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await weth.approve(router, constants.MAX_UINT256, {from: investor1});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate price movment by trading in the pool
        const large_number = toBN(1E6).mul(toBN(1E18));
        let change;
        while (true) {
            await setBalance('dai', investor1, '1000000');
            await swap(large_number, [tokens.dai.address, tokens.weth.address])
            change = await primaryStrategy.volatilityCheck();
            // once were above a 4% price change
            if (change == true) break;
        }
        // run harvest
        await daiAdaptor.strategyHarvest(0, {from: governance})
        // active position should == 0
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // revert the swap
        const userWant = await weth.balanceOf(investor1);
        await swap(userWant, [tokens.weth.address, tokens.dai.address])
        // the previous position should have no debt nor collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");

        return revertChain(sid);
    })
  })

  // Adjusting the position by adding and removing assets - can be done during harvest events (adding credit) or withdrawals
  describe('Adjusting position', function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
    })

    // If we have a healthy position we should take on more debt when we add assets to the position
    it('Should take on more debt and hold more colateral when adding to the positions', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add assets to daiAdaptor
        await setBalance('dai', daiAdaptor.address, '1000000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        // the debt and collateral should both have increased
        assert.isAbove(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
    })

    // we should take on more debt if the position is unhealthy
    it('Should not take on more debt when adding if above target collateral factor', async () => {
        // set the collateral factor
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await setBalance('dai', daiAdaptor.address, '1000000');
        // add to position
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        // debt should remain the same
        assert.strictEqual(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        // collateral should ahve increased
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
    })

    // We need to close the position under certain conditions to aboid liquidation, these conditions
    // are unlikely to occur as price volatility should push us to close a position before anything
    it('Should close the position if above collateral threshold when adding assets', async () => {
        // set collateral factor and treshold
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(10),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await setBalance('dai', daiAdaptor.address, '1000000');
        // try adding to position
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        // position is closed, no debt nor collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should be posible to remove assets from a position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        const initUserDai = await dai.balanceOf(governance);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(30000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // position remains the same
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
        // withdrawer should have more dai
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    // if vault debts to the strategy increases, the strategy should try to unwind the position to
      // pay these back
    it('Should be posible to pay back debt to the vault', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        const stratData = await daiAdaptor.strategies(primaryStrategy.address);
        // set new debtRatio to 70%
        const expected = await primaryStrategy.expectedReturn();
        await daiAdaptor.updateStrategyDebtRatio(primaryStrategy.address, 7000, {from: governance});

        const initVaultDai = await dai.balanceOf(daiAdaptor.address);
        return expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(expected);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(30000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // adaptor should have more dai
        await expect(dai.balanceOf(daiAdaptor)).to.eventually.be.a.bignumber.gt(initVaultDai);
        // position remains the same
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
        return expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('Should adjust the position when withdrawing up to 80% of position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserDai = await dai.balanceOf(governance);
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(775000).mul(toBN(1E18)) // ~ 79.5% of the position
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(position));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should close position if withdrawing more than 80% of position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserDai = await dai.balanceOf(governance);
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(850000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        // position is closed
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // withdrawer has more dai
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        // position has no debt or collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should close the position if collateral ratio is above threshold when withdrawing', async () => {
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(10),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserDai = await dai.balanceOf(governance);
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(40000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('Assets interactions', function () {
    beforeEach(async function () {
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await sushi.approve(router, constants.MAX_UINT256, {from: investor1});
        await weth.approve(router, constants.MAX_UINT256, {from: investor1});
    })

    // Should be able to see how much sushi we are expecting
    it('Should correctly estimated sushi assets', async () => {
        const sid = await snapshotChain();
        await setBalance('dai', daiAdaptor.address, '10000000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi(position);
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        return expect(primaryStrategy.pendingSushi(position)).to.eventually.be.a.bignumber.gt(initSushi);
    })

    // Sell assets
    it('Should correctly sell of eth and sushi', async () => {
        const sid = await snapshotChain();
        await setBalance('dai', daiAdaptor.address, '10000000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi(position);
        for (let i = 0; i < 1000; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        let change;
        const larget_number = toBN(1E4).mul(toBN(1E18));
        while (true) {
            await setBalance('weth', investor1, '10000');
            await expect(swap(larget_number, [tokens.weth.address, tokens.dai.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await daiAdaptor.strategyHarvest(0, {from: governance});
        // revert the swap
        const userWant = await dai.balanceOf(investor1);
        await swap(userWant, [tokens.dai.address, tokens.weth.address])
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        await network.provider.send("evm_mine");
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(initSushi);
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(initEth);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(0), toBN(1E15));

        return revertChain(sid);
    })

    // should be able to estiamte totalAsset changes
    it('Should estimate totalAssets', async () => {
        const sid = await snapshotChain();
        await setBalance('dai', daiAdaptor.address, '10000000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const amount = '100000'
        const position = await primaryStrategy.activePosition();
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await dai.balanceOf(primaryStrategy.address);
        await setBalance('dai', primaryStrategy.address, amount);
        // expect totalAssets
        const expected = toBN(amount).mul(toBN(1E18)).sub(reserves).add(initAssets);
        // estimated totalAssets
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.equal(expected);
        // update sushi rewards
        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi(position);
        // pass 10 blocks
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        // expected total assets without sushi rewards...
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expected);
        const expectedNoSushi = await primaryStrategy.estimatedTotalAssets();
        await masterChef.methods.updatePool(2).send({from: governance});
        // ..should be lower than when we updated the rewards
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expectedNoSushi);
    })

    // Simulate changes in expected return
    it('Should estimate expected return', async () => {
        const sid = await snapshotChain();
        const initPosition = await primaryStrategy.activePosition();
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(toBN(0));
        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const expected = await primaryStrategy.expectedReturn();
        const alphaData = await homoraBank.methods.getPositionInfo(initPosition).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(initPosition).call()
        await daiAdaptor.strategyHarvest(0, {from: governance});
        // Expect position expected return to be 0
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.eq(toBN(0));
        const stratData = await daiAdaptor.strategies(primaryStrategy.address);
        const position = await primaryStrategy.activePosition();
        const alphaDataPre = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtPre = await homoraBank.methods.getPositionDebts(position).call()
        const amount = '200000'
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await dai.balanceOf(primaryStrategy.address);
        // add "profit" to strategy
        await setBalance('dai', primaryStrategy.address, amount);
        // should report more asssets and more expected returns
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(initAssets);
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(expected);
        const preSwap = await primaryStrategy.expectedReturn();
        const large_number = toBN(1E5).mul(toBN(1E18));
        let change;
        // simulate swaps
        while (true) {
            await setBalance('weth', investor1, '100000');
            await swap(large_number, [tokens.weth.address, tokens.dai.address])
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        // revert the swap to neutral
        const userdai = await dai.balanceOf(investor1);
        await swap(userdai, [tokens.dai.address, tokens.weth.address]);
        await network.provider.send("evm_mine");
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(10),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        // should now have additional gains from swapping fee and sushi tokens
        await masterChef.methods.updatePool(2).send({from: governance});
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(preSwap);
        // harvest gains
        // await daiAdaptor.strategyHarvest(0, {from: governance});
        const alphaDataFin = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtFin = await homoraBank.methods.getPositionDebts(position).call()

        // expectedReturn should be back at 0 (but report profit)
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(toBN(0));

        return revertChain(sid);
    })
  })

  describe("Setters", function () {

    it('Should be possible to change the minWant', async () => {
        const originalWant = await primaryStrategy.minWant();
        await expect(originalWant).to.be.a.bignumber.gt(toBN(0));
        await primaryStrategy.setMinWant(0, {from: governance});
        return expect(primaryStrategy.minWant()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('Should be possible to change to reserves', async () => {
        const originalReserve = await primaryStrategy.reserves();
        await expect(originalReserve).to.be.a.bignumber.gt(toBN(0));
        await primaryStrategy.setReserves(0, {from: governance});
        return expect(primaryStrategy.reserves()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('Should be possible to change the ILThreshold', async () => {
        const originalIlThreshold = await primaryStrategy.ilThreshold();
        await expect(originalIlThreshold).to.be.a.bignumber.equal(toBN(400));
        // cant set threshold above 100%
        await expect(primaryStrategy.setIlThreshold(10001)).to.eventually.be.rejected;
        await primaryStrategy.setIlThreshold(100, {from: governance});
        return expect(primaryStrategy.ilThreshold()).to.eventually.be.a.bignumber.equal(toBN(100));
    })

    it('Should not be possible to interact with setter unless owner of strategy', async () => {
        await expect(primaryStrategy.setMinWant(100)).to.eventually.be.rejected;
        await expect(primaryStrategy.setReserves(100)).to.eventually.be.rejected;
        return expect(primaryStrategy.setIlThreshold(100)).to.eventually.be.rejected;
    })

  })

  describe("Utility", function () {
    it('Should be possible to get the strategy Name', async () => {
        return expect(primaryStrategy.name()).to.eventually.equal('Ahv2 strategy');
    })
  })
})
