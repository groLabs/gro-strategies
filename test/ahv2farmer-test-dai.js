require('dotenv').config();
const MockERC20 = artifacts.require('MockERC20')
const TestStrategy = artifacts.require('TestStrategy')
const AHStrategy = artifacts.require('AHv2FarmerDai')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')

const { toBN, BN, toWei } = web3.utils
const { constants } = require('./utils/constants');
const { expect, ZERO, tokens, setBalance, setStorageAt, toBytes32 } = require('./utils/common-utils');
const fs = require('fs');

const abiDecoder = require('abi-decoder');

const sushiSpell =  '0xdbc2aa11aa01baa22892de745c661db9f204b2cd'
const router = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const pool = '0x87Dee1cC9FFd464B79e058ba20387c1984aed86a'
const AHGov = '0xc05195e2EE3e4Bb49fA989EAA39B88A5001d52BD'
const poolID = 37; // Master chef pool id

const proxyHomora = '0x376d16C7dE138B01455a51dA79AD65806E9cd694'
const sushiToken = '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd'
const chef = '0xd6a4F121CA35509aF06A0Be99093d08462f53052'

const homoraABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/homora.json"));
const spellSushiABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/sushiSpell.json"));
const masterChefABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/MasterChef.json"));
const uniABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/IUni.json"));
const allowance = toBN(1E18).mul(toBN(1E6))
const baseAllowance = toBN(1E5).mul(toBN(1E18));

let daiAdaptor,
    dai,
    avax,
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
    investor2,
    bouncer;

contract('Alpha homora test dai/avax joe pool', function (accounts) {
  admin = accounts[0]
  governance = accounts[1]
  bouncer = accounts[2]
  investor1 = accounts[8]
  investor2 = accounts[9]
  const amount = toBN(10000)
  const borrowLimit = toBN(1E7).mul(toBN(1E18))
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
    avax = await MockERC20.at(tokens.avax.address);
    sushi = await MockERC20.at(sushiToken);

    // create the vault adapter
    daiAdaptor = await VaultAdaptor.new(tokens.dai.address, baseAllowance, bouncer, {from: governance})
    daiVault = daiAdaptor;

    // create and add the AHv2 strategy to the adapter
    primaryStrategy = await AHStrategy.new(daiVault.address, sushiSpell, router, pool, poolID, [tokens.avax.address, tokens.dai.address], tokens.usdc.address);
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
    await web3.eth.sendTransaction({to: AHGov, from: accounts[0], value: toWei('10', 'ether')})
    await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov})
    await homoraBank.methods.setCreditLimits([[primaryStrategy.address, avax.address, toBN(1E18).mul(toBN(1E18)).toString()]]).send({from: AHGov})
    await daiAdaptor.addToWhitelist(governance, {from: governance});
    await primaryStrategy.setMinWant(toBN(100).mul(toBN(1E18)), {from: governance});

    await daiAdaptor.setDepositLimit(constants.MAX_UINT256, {from: governance});
    await dai.approve(daiAdaptor.address, allowance, {from: investor1});
    await daiAdaptor.setUserAllowance(investor1, allowance, {from: bouncer});
    await dai.approve(daiAdaptor.address, constants.MAX_UINT256, {from: investor2});
    await daiAdaptor.setUserAllowance(investor2, allowance, {from: bouncer});

    await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});
    await primaryStrategy.setAmmThreshold(dai.address, 3000, {from: governance});
    await primaryStrategy.setAmmThreshold(sushiToken, 3000, {from: governance});
    await primaryStrategy.setStrategyThresholds(400, 10, 10, 5000, {from: governance});

    for (let i = 0; i < 10; i++) {
      await network.provider.send("evm_mine");
    }
  })

  // The strategy needs to be able to open positions in AHv2
  describe("Opening position", function () {
    beforeEach(async function () {
        // give that adapor 1M
        const amount = '10000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
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
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.is.a.bignumber.gt(toBN("0"));
    })

    it('Should limit the size of a new position to the borrow limit if more assets are available', async () => {
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        // set a borrow limit of 2M
        const borrowLimit = toBN(1E6).mul(toBN(1E18));
        const deposit = '2000000';
        const deposit_norm = toBN('2000000').mul(toBN(1E18));
        await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

        // add 3M to daiAdaptor
        await setBalance('dai', daiAdaptor.address, deposit);
        // open a new position
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // the estimated assets should be ~ 2M but the position size <= 1M
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(deposit_norm, toBN(1E18));
        return expect(primaryStrategy.calcEstimatedWant()).to.eventually.be.a.bignumber.lte(borrowLimit);
    })

    // Check that we can add assets to a position
    it('Should be possible to add to a position', async () => {
        await daiAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add 1 M dai to adaper
        await setBalance('dai', daiAdaptor.address, '10000');
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
        const amount = '100000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
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
        await primaryStrategy.forceClose(position, {from: governance});
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // position should have no debt or collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should close the position if the price has diviated with more than 5%', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate price movment by trading in the pool
        const large_number = toBN(2000).mul(toBN(1E18));
        const smaller_number = toBN(200).mul(toBN(1E18));
        let change;
        while (true) {
            await setBalance('avax', investor1, '200');
            await swap(smaller_number, [tokens.avax.address, tokens.dai.address])
            await swap(large_number, [tokens.dai.address, tokens.avax.address])
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
        const userWant = await avax.balanceOf(investor1);
        await swap(userWant, [tokens.avax.address, tokens.dai.address])
        // the previous position should have no debt nor collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");

        return revertChain(sid);
    })

    it('Should be possible to close the position after a max amount of time', async () => {
        const sid = await snapshotChain();
        // simulate price movment by trading in the pool
        const position = await primaryStrategy.activePosition();
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.equal(false);
        const timestamp = (await web3.eth.getBlock('latest')).timestamp;
        const newTimestamp = toBN(timestamp).add(toBN("21605"));
        await network.provider.request(
            {
                method: "evm_setNextBlockTimestamp",
                params: [newTimestamp.toNumber()]
            }
        );
        await network.provider.send("evm_mine");
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.equal(true);
        // run harvest
        await daiAdaptor.strategyHarvest(0, {from: governance})
        // active position should == 0
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // revert the swap
        // the previous position should have no debt nor collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");

        return revertChain(sid);
    })

    it('Should be possible to close the position if we have exceeded the borrow limit', async () => {
        const sid = await snapshotChain();
        // simulate price movment by trading in the pool
        const position = await primaryStrategy.activePosition();
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.equal(false);
        await primaryStrategy.setBorrowLimit(0, {from: governance});
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.equal(true);
        // run harvest
        await daiAdaptor.strategyHarvest(0, {from: governance})
        // active position should == 0
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // revert the swap
        // the previous position should have no debt nor collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");

        return revertChain(sid);
    })
  })

  // Adjusting the position by adding and removing assets - can be done during harvest events (adding credit) or withdrawals
  describe('Adjusting position', function () {
    beforeEach(async function () {
        const amount = '10000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
        await daiAdaptor.strategyHarvest(0, {from: governance})
    })


    it('Should take on more debt and hold more colateral when adding to the positions', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add assets to daiAdaptor
        await setBalance('dai', daiAdaptor.address, '10000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        // the debt and collateral should both have increased
        assert.isAbove(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should limit the amount the position is adjusted by depending on the borrow limit', async () => {
        const position = await primaryStrategy.activePosition();
        // set a borrow limit of 1M
        const borrowLimit = toBN(1E5).mul(toBN(1E18))
        await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

        // add 1M to daiAdaptor
        await setBalance('dai', daiAdaptor.address, '100000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        // the estimated assets should be > 1M (1M + 10k) but the position size <= 1M
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(borrowLimit);
        return expect(primaryStrategy.calcEstimatedWant()).to.eventually.be.a.bignumber.lte(borrowLimit);
    })

    // we should take on more debt if the position is unhealthy
    it.skip('Should not take on more debt when adding if above target collateral factor', async () => {
        // set the collateral factor
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await setBalance('dai', daiAdaptor.address, '10000');
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
    it.skip('Should close the position if above collateral threshold when adding assets', async () => {
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

        await setBalance('dai', daiAdaptor.address, '10000');
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

        const initUserdai = await dai.balanceOf(investor1);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const amount = toBN(3000).mul(toBN(1E18))
        await daiAdaptor.withdraw(amount, 1000, {from:investor1});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // position remains the same
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
        // withdrawer should have more dai
        await expect(dai.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserdai);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    // if vault debts to the strategy increases, the strategy should try to unwind the position to pay these back
    it('Should be posible to pay back debt to the vault', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        const stratData = await daiAdaptor.strategies(primaryStrategy.address);
        // set new debtRatio to 70%
        const expected = await primaryStrategy.expectedReturn();
        await daiAdaptor.setDebtRatio(primaryStrategy.address, 7000, {from: governance});

        const initVaultdai = await dai.balanceOf(daiAdaptor.address);
        return expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(expected);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const amount = toBN(3000).mul(toBN(1E18))
        await daiAdaptor.withdraw(amount, 1000, {from:investor1});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // adaptor should have more dai
        await expect(dai.balanceOf(daiAdaptor)).to.eventually.be.a.bignumber.gt(initVaultdai);
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
        const initUserdai = await dai.balanceOf(investor1);
        const amount = toBN(7750).mul(toBN(1E18)) // ~ 79.5% of the position
        await daiAdaptor.withdraw(amount, 1000, {from:investor1});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(position));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(dai.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserdai);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should close position if withdrawing more than 80% of position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserdai = await dai.balanceOf(investor1);
        const amount = toBN(8500).mul(toBN(1E18))
        await daiAdaptor.withdraw(amount, 5, {from:investor1});

        // position is closed
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // withdrawer has more dai
        await expect(dai.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserdai);
        // position has no debt or collateral
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it.skip('Should close the position if collateral ratio is above threshold when withdrawing', async () => {
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
        const initUserdai = await dai.balanceOf(investor1);
        const amount = toBN(4000).mul(toBN(1E18))
        await daiAdaptor.withdraw(amount, 1000, {from:investor1});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(dai.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserdai);
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('long/short adjustments', function () {
    beforeEach(async function () {
        const amount = '100000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await primaryStrategy.setStrategyThresholds(400, 10, 100, 5000, {from: governance});
    })

    it('Should be possible to adjust a long position towards a market netural position', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})

        // first harvest
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initExposure = await primaryStrategy.getExposure();
        //await expect(daiAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        // Not overexposed
        assert.equal(initExposure[0], false);
        assert.equal(initExposure[1], false);
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        let _assets = await primaryStrategy.estimatedTotalAssets();
        let _avax = await web3.eth.getBalance(primaryStrategy.address);

        let change;
        const large_number = toBN(1E3).mul(toBN(1E18));
        // simulate swaps
        while (true) {
            await setBalance('avax', investor1, '1000');
            await expect(swap(large_number, [tokens.avax.address, tokens.dai.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        // increase the il threshold to stop the position from closing
        // should now tend towards market neutral during each harvest
        await primaryStrategy.setStrategyThresholds(800, 10, 100, 5000, {from: governance});
        let lastExposure = await primaryStrategy.getExposure();
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        let currentPos = await primaryStrategy.activePosition();
        // over exposed and long
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], false);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        await expect(lastExposure[2][1]).to.be.a.bignumber.gt(toBN(0));
        let currentExposure = lastExposure[2][1];

        // second harvest
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;

        // we pay back 50% of over over exposure, but since we started at 400 bp price change
        // we still expect to be overexposed
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        // should have avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(_avax);
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        currentPos = await primaryStrategy.activePosition();

        // still over exposed and long
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(200E18));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we are overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        await expect(lastExposure[2][1]).to.be.a.bignumber.lt(currentExposure);
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        // second harvest - sells off all avax, adjust the position (depending on minWant threshold)
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        // should have less avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.lt(_avax);
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        // still over exposed and long
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(200E18));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we are overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        // exposure should be less
        await expect(lastExposure[2][1]).to.be.a.bignumber.closeTo(currentExposure, toBN(40E18));
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        // third harvest, should have reduced the exposure below limit
        await daiAdaptor.strategyHarvest(0, {from: governance});
        // should still have some avax left
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(toBN(0));
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        lastExposure = await primaryStrategy.getExposure();

        // we're not over exposed anymore but will still have
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(200E18));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we arent overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));

        // should still have some avax to sell
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;

        // forth harvest
        await daiAdaptor.strategyHarvest(0, {from: governance});
        // should have sold all avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        lastExposure = await primaryStrategy.getExposure();
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(200E18));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we arent overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        return revertChain(sid);
    })

    it.only('Should report gains/losses only after selling all tokens', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '1000000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        let change;
        const ava_swap = toBN(1E4).mul(toBN(1E18));
        const usd_swap = toBN(5E4).mul(toBN(1E6));
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(ava_swap, [tokens.avax.address, tokens.dai.address])).to.eventually.be.fulfilled;
            await expect(swap(usd_swap, [tokens.dai.address, tokens.avax.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        const swap_amount = await dai.balanceOf(investor1);

        strat_data = await daiAdaptor.strategies(primaryStrategy.address);
        console.log('----------------------------------1')
        console.log('active pos ' + await primaryStrategy.activePosition());
        console.log('active pos avax ' + await web3.eth.getBalance(primaryStrategy.address));
        console.log('strat gain ' + strat_data.totalGain)
        console.log('strat loss ' + strat_data.totalLoss)
        console.log('strat debt ' + strat_data.totalDebt)
        await daiAdaptor.strategyHarvest(0, {from: governance});
        await web3.eth.sendTransaction({to: primaryStrategy.address, from: accounts[0], value: toWei('10', 'ether')})

        await expect(swap(swap_amount, [tokens.dai.address, tokens.avax.address])).to.eventually.be.fulfilled;
        console.log('----------------------------------2')
        strat_data = await daiAdaptor.strategies(primaryStrategy.address);
        console.log('active pos ' + await primaryStrategy.activePosition());
        console.log('active pos avax ' + await web3.eth.getBalance(primaryStrategy.address));
        console.log('strat gain ' + strat_data.totalGain)
        console.log('strat loss ' + strat_data.totalLoss)
        console.log('strat debt ' + strat_data.totalDebt)
        await daiAdaptor.strategyHarvest(0, {from: governance});
        console.log('----------------------------------3')
        strat_data = await daiAdaptor.strategies(primaryStrategy.address);
        console.log('active pos ' + await primaryStrategy.activePosition());
        console.log('active pos avax ' + await web3.eth.getBalance(primaryStrategy.address));
        console.log('strat gain ' + strat_data.totalGain)
        console.log('strat loss ' + strat_data.totalLoss)
        console.log('strat debt ' + strat_data.totalDebt)
        await daiAdaptor.strategyHarvest(0, {from: governance});
        console.log('----------------------------------4')
        strat_data = await daiAdaptor.strategies(primaryStrategy.address);
        console.log('active pos ' + await primaryStrategy.activePosition());
        console.log('active pos avax ' + await web3.eth.getBalance(primaryStrategy.address));
        console.log('strat gain ' + strat_data.totalGain)
        console.log('strat loss ' + strat_data.totalLoss)
        console.log('strat debt ' + strat_data.totalDebt)
    })

    it('Should not open up a new position when holding more than 1 AVAX', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        const initExposure = await primaryStrategy.getExposure();
        let change;
        const large_number = toBN(1E3).mul(toBN(1E18));
        while (true) {
            await setBalance('avax', investor1, '1000');
            await expect(swap(large_number, [tokens.avax.address, tokens.dai.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await primaryStrategy.setStrategyThresholds(800, 100, 100, 5000, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();

        // we should have an active position
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        // we close it
        await primaryStrategy.forceClose((await primaryStrategy.activePosition()).toString(), {from: governance});
        // active position should be 0
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        let avaxBal = await web3.eth.getBalance(primaryStrategy.address)

        // harvest shouldnt open a position
        await daiAdaptor.strategyHarvest(0, {from: governance});
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        lastExposure = await primaryStrategy.getExposure();
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        // we should have sold of enough avax to open a position
        await daiAdaptor.strategyHarvest(0, {from: governance});
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        lastExposure = await primaryStrategy.getExposure();
        // we are still over exposed, so need to run another harvest cycle to get close enough market netural
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        return revertChain(sid);
    })

    it('Should be possible to adjust a short position towards a market netural position', async () => {
        const sid = await snapshotChain();
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(toBN(amount).mul(toBN(1E18)), {from: investor1})
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initExposure = await primaryStrategy.getExposure();
        //await expect(daiAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        // Not overexposed
        assert.equal(initExposure[0], false);
        assert.equal(initExposure[1], false);
        let _assets = await primaryStrategy.estimatedTotalAssets();

        let change;
        const large_number = toBN(1E5).mul(toBN(1E18));
        while (true) {
            await setBalance('dai', investor1, '100000');
            await swap(large_number, [tokens.dai.address, tokens.avax.address])
            change = await primaryStrategy.volatilityCheck();
            // once were above a 4% price change
            if (change == true) break;
        }

        // increase the il threshold to stop the position from closing
        // should now tend towards market neutral during each harvest
        await primaryStrategy.setStrategyThresholds(800, 100, 100, 5000, {from: governance});
        let lastExposure = await primaryStrategy.getExposure();
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        let currentPos = await primaryStrategy.activePosition();
        // over exposed and short
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], true);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));
        await expect(lastExposure[2][1]).to.be.a.bignumber.gt(toBN(0));
        let currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        // first harvest
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();


        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        currentPos = await primaryStrategy.activePosition();
        // over exposed and short
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], true);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));
        await expect(lastExposure[2][1]).to.be.a.bignumber.lt(currentExposure);
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        // second harvest
        await daiAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();

        // over exposed and short
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], true);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));
        await expect(lastExposure[2][1]).to.be.a.bignumber.lt(currentExposure);
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        // third harvest
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        await daiAdaptor.strategyHarvest(0, {from: governance});

        lastExposure = await primaryStrategy.getExposure();

        // over exposed and short
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], true);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;

        await daiAdaptor.strategyHarvest(0, {from: governance});

        lastExposure = await primaryStrategy.getExposure();

        // over exposed and short
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));

        return expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
    })
  })

  describe('Assets interactions', function () {
    beforeEach(async function () {
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await sushi.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});
    })

    // No joe rewards for dai
    it.skip('Should correctly estimated sushi assets', async () => {
        const sid = await snapshotChain();
        await setBalance('dai', daiAdaptor.address, '100000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        await masterChef.methods.updatePool(poolID).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(poolID).send({from: governance});
        return expect(primaryStrategy.pendingYieldToken(position)).to.eventually.be.a.bignumber.gt(initSushi);
    })

    // Sell assets
    it('Should correctly sell of eth and sushi', async () => {
        const sid = await snapshotChain();
        await setBalance('dai', daiAdaptor.address, '10000');
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await masterChef.methods.updatePool(poolID).send({from: governance});
        // const initSushi =  await primaryStrategy.pendingYieldToken(position);
        for (let i = 0; i < 1000; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(poolID).send({from: governance});
        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        let change;
        const larget_number = toBN(1E4).mul(toBN(1E18));
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(larget_number, [tokens.avax.address, tokens.dai.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await daiAdaptor.strategyHarvest(0, {from: governance});
        // revert the swap
        const userWant = await dai.balanceOf(investor1);
        await swap(userWant, [tokens.dai.address, tokens.avax.address])
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(toBN(0));
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        await network.provider.send("evm_mine");
        // eth and sushi sold off
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));

        return revertChain(sid);
    })

    // should be able to estiamte totalAsset changes
    it('Should estimate totalAssets', async () => {
        const sid = await snapshotChain();
        const amount = '10000'
        await setBalance('dai', daiAdaptor.address, amount);
        await daiAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await dai.balanceOf(primaryStrategy.address);
        await setBalance('dai', primaryStrategy.address, amount);
        // expect totalAssets
        const expected = toBN(amount).mul(toBN(1E18)).sub(reserves).add(initAssets);
        // estimated totalAssets
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.equal(expected);
        // update sushi rewards
        await masterChef.methods.updatePool(poolID).send({from: governance});
        //const initSushi =  await primaryStrategy.pendingYieldToken(position);
        // pass 10 blocks
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        // no sushi rewards for dai pool
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(expected, toBN(1));
        const expectedNoSushi = await primaryStrategy.estimatedTotalAssets();
        await masterChef.methods.updatePool(poolID).send({from: governance});
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(expectedNoSushi, toBN(1));
    })

    // Simulate changes in expected return
    it('Should estimate expected return', async () => {
        const sid = await snapshotChain();
        const initPosition = await primaryStrategy.activePosition();
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(toBN(0));
        await setBalance('dai', investor1, '10000');
        await daiAdaptor.deposit(toBN('10000').mul(toBN(1E18)), {from: investor1})
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
        // await setBalance('dai', primaryStrategy.address, amount);
        // should report more asssets and more expected returns
        // await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(initAssets);
        // await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(expected);
        const preSwap = await primaryStrategy.expectedReturn();
        const large_number = toBN(1E5).mul(toBN(1E18));
        let change;
        // simulate swaps
        while (true) {
            await setBalance('avax', investor1, '100000');
            await swap(large_number, [tokens.avax.address, tokens.dai.address])
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        // revert the swap to neutral
        const userdai = await dai.balanceOf(investor1);
        await swap(userdai, [tokens.dai.address, tokens.avax.address]);
        await network.provider.send("evm_mine");
        // should now have additional gains from swapping fee and sushi tokens
        for (let i = 0; i < 100; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(poolID).send({from: governance});
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(preSwap);
        const preHarvestProfit = (await daiAdaptor.strategies(primaryStrategy.address)).totalGain;
        const expectedPreHarvest = await primaryStrategy.expectedReturn();
        // harvest gains
        const pricePerShare = await daiVault.getPricePerShare();
        await primaryStrategy.forceClose(position, {from: governance})
        await daiAdaptor.strategyHarvest(0, {from: governance});
        await expect(daiVault.getPricePerShare()).to.eventually.be.a.bignumber.equal(pricePerShare);
        for (let i = 0; i < 100; i++) {
          await network.provider.send("evm_mine");
        }
        await expect(daiVault.getPricePerShare()).to.eventually.be.a.bignumber.gt(pricePerShare);
        const alphaDataFin = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtFin = await homoraBank.methods.getPositionDebts(position).call()

        // expectedReturn should be back at 0
        await expect(daiAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.lt(expectedPreHarvest);

        return revertChain(sid);
    })
  })

  describe("Setters", function () {

    it('Should be possible to change the minWant', async () => {
        const originalWant = await primaryStrategy.minWant();
        await expect(originalWant).to.be.a.bignumber.equal(toBN('100000000000000000000'));
        await primaryStrategy.setMinWant(200, {from: governance});
        return expect(primaryStrategy.minWant()).to.eventually.be.a.bignumber.equal(toBN(200));
    })

    it('Should not be possible to interact with setter unless owner of strategy', async () => {
        await expect(primaryStrategy.setMinWant(100)).to.eventually.be.rejected;
        return expect(primaryStrategy.setStrategyThresholds(100, 10, 50, 5000)).to.eventually.be.rejected;
    })
  })

  describe("Utility", function () {
    it('Should be possible to get the strategy Name', async () => {
        return expect(primaryStrategy.name()).to.eventually.equal('AHv2 strategy');
    })

    it('Should revert if a an AMM check fails', async () => {
        const amount = '10000';
        const amount_norm_dai = toBN(amount).mul(toBN(1E18));
        const amount_norm_weth = toBN(amount).mul(toBN(1E18));
        await setBalance('dai', investor1, amount);
        await daiAdaptor.deposit(amount_norm_dai, {from: investor1})
        await expect(daiAdaptor.strategyHarvest(0, amount_norm_dai, amount_norm_weth, {from: governance})).to.eventually.be.rejected;
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.eq(toBN(0));
        await daiAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        const position = primaryStrategy.activePosition()
        // force close the position
        await primaryStrategy.setAmmThreshold(dai.address, 0, {from: governance});
        return expect(primaryStrategy.forceClose(position, {from: governance})).to.eventually.be.rejected;
    })
  })
})
