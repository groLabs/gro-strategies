require('dotenv').config();
const MockERC20 = artifacts.require('MockERC20')
const TestStrategy = artifacts.require('TestStrategy')
const AHStrategy = artifacts.require('AHv2Farmer')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')

const { toBN, BN, toWei } = web3.utils
const { constants } = require('./utils/constants');
const { expect, ZERO, tokens, setBalance, setStorageAt, toBytes32 } = require('./utils/common-utils');
const fs = require('fs');

const abiDecoder = require('abi-decoder');

const sushiSpell =  '0xdbc2aa11aa01baa22892de745c661db9f204b2cd'
const router = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'
const pool = '0xA389f9430876455C36478DeEa9769B7Ca4E3DDB1'
const AHGov = '0xc05195e2EE3e4Bb49fA989EAA39B88A5001d52BD'
const poolID = 39; // Master chef pool id

const proxyHomora = '0x376d16C7dE138B01455a51dA79AD65806E9cd694'
const sushiToken = '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd'
const chef = '0xd6a4F121CA35509aF06A0Be99093d08462f53052'

const homoraABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/homora.json"));
const spellSushiABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/sushiSpell.json"));
const masterChefABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/MasterChef.json"));
const uniABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/IUni.json"));
const allowance = toBN(1E18)
const baseAllowance = toBN(10).mul(toBN(1E6));

let usdcAdaptor,
    usdc,
    avax,
    sushi,
    usdcVault,
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

contract('Alpha homora test usdc/avax joe pool', function (accounts) {
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
    usdc = await MockERC20.at(tokens.usdc.address);
    avax = await MockERC20.at(tokens.avax.address);
    sushi = await MockERC20.at(sushiToken);

    // create the vault adapter
    usdcAdaptor = await VaultAdaptor.new(tokens.usdc.address, baseAllowance, bouncer, {from: governance})
    usdcVault = usdcAdaptor;

    // create and add the AHv2 strategy to the adapter
    primaryStrategy = await AHStrategy.new(usdcVault.address, sushiSpell, router, pool, poolID, [tokens.usdc.address, tokens.avax.address], ZERO);
    await primaryStrategy.setKeeper(usdcAdaptor.address, {from: governance});
    const botLimit = toBN(0)
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    await usdcVault.addStrategy(
      primaryStrategy.address,
      10000, // set debtRatio to 100%
      botLimit, topLimit,
      { from: governance }
    )

    // add a secondary dummy strategy, potentially not necessary but we have done
    // all modelling with the assumption that we have 2 strategies per vault min.
    secondaryStrategy = await TestStrategy.new(usdcVault.address)
    await secondaryStrategy.setKeeper(usdcAdaptor.address, {from: governance});
    await usdcVault.addStrategy(
      secondaryStrategy.address,
      0,
      botLimit, topLimit,
      { from: governance }
    )

    // add strategy to whitelist in homorabank and gov to whitelist in adapter so they can call harvest
    await web3.eth.sendTransaction({to: AHGov, from: accounts[0], value: toWei('10', 'ether')})
    await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov})
    await homoraBank.methods.setCreditLimits([[primaryStrategy.address, avax.address, toBN(1E18).mul(toBN(1E18)).toString()]]).send({from: AHGov})
    await usdcAdaptor.addToWhitelist(governance, {from: governance});
    await primaryStrategy.setMinWant(toBN(100).mul(toBN(1E6)), {from: governance});

    await usdcAdaptor.setDepositLimit(constants.MAX_UINT256, {from: governance});
    await usdc.approve(usdcAdaptor.address, allowance, {from: investor1});
    await usdcAdaptor.setUserAllowance(investor1, allowance, {from: bouncer});
    await usdc.approve(usdcAdaptor.address, constants.MAX_UINT256, {from: investor2});
    await usdcAdaptor.setUserAllowance(investor2, allowance, {from: bouncer});

    await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});
    await primaryStrategy.setAmmThreshold(usdc.address, 2000, {from: governance});
    await primaryStrategy.setAmmThreshold(sushiToken, 2000, {from: governance});

    for (let i = 0; i < 10; i++) {
      await network.provider.send("evm_mine");
    }
  })

  // The strategy needs to be able to open positions in AHv2
  describe("Opening position", function () {
    beforeEach(async function () {
        // give that adapor 1M
        const amount = '10000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
    })

    // Given an investment of 1M usdc, the strategy should open up a market neutral position
    // (2x) leverage of usdc/eth in sushiswap through alpha homora
    it('Should be possible to open up a position in AHv2', async () => {
        // We dont have a position
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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
        const borrowLimit = toBN(1E6).mul(toBN(1E6));
        const deposit = '2000000';
        const deposit_norm = toBN('2000000').mul(toBN(1E6));
        await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

        // add 3M to usdcAdaptor
        await setBalance('usdc', usdcAdaptor.address, deposit);
        // open a new position
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // the estimated assets should be ~ 2M but the position size <= 1M
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(deposit_norm, toBN(1E18));
        return expect(primaryStrategy.calcEstimatedWant()).to.eventually.be.a.bignumber.lte(borrowLimit);
    })

    // Check that we can add assets to a position
    it('Should be possible to add to a position', async () => {
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // add 10k usdc to adaper
        const amount = '10000'
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        // run harvest
        await expect(usdcAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.fulfilled;
        // we should have the same position
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })

    // Check that we can add assets to a position
    it('Should correctly invest available assets when opening a position independent of gains', async () => {
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // add 10k usdc to adaper
        const init_estimated_assets = await primaryStrategy.estimatedTotalAssets();
        const amount = '10000'
        await setBalance('usdc', investor1, amount);
        await setBalance('usdc', primaryStrategy.address, '2000');
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.closeTo(toBN(amount).mul(toBN(1E6)), toBN(1E6))
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(2000).mul(toBN(1E6)), toBN(1E6))
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(init_estimated_assets.add(toBN(2000).mul(toBN(1E6))), toBN(1E6))
        const estimated_assets = await primaryStrategy.estimatedTotalAssets();

        // run harvest
        await expect(usdcAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.fulfilled;
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0))
        // we should have the same position
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(estimated_assets.add(toBN(amount).mul(toBN(1E6))), toBN(1E6))
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })
  })

  // Given an existing positon, it should be possible to close it at will, or through calling
  // harvest/tend, given a specific set of circumstances.
  describe('Closing position', function () {
    beforeEach(async function () {
        const amount = '100000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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
        await usdc.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate price movment by trading in the pool
        const large_number = toBN(1E6).mul(toBN(1E6));
        let change;
        while (true) {
            await setBalance('usdc', investor1, '1000000');
            await swap(large_number, [tokens.usdc.address, tokens.avax.address])
            change = await primaryStrategy.volatilityCheck();
            // once were above a 4% price change
            if (change == true) break;
        }
        // run harvest

        await usdcAdaptor.strategyHarvest(0, {from: governance})
        expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(toBN(0));
        // active position should == 0
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        // revert the swap
        const userWant = await avax.balanceOf(investor1);
        await swap(userWant, [tokens.avax.address, tokens.usdc.address])
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
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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

    // Check that we can add assets to a position
    it('Should correctly invest available assets after force closing independent of profit status', async () => {
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // add 10k usdc to adaper
        const init_estimated_assets = await primaryStrategy.estimatedTotalAssets();
        const amount = '10000'
        await setBalance('usdc', investor1, amount);
        await setBalance('usdc', primaryStrategy.address, '2000');
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.closeTo(toBN(amount).mul(toBN(1E6)), toBN(1E6))
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(2000).mul(toBN(1E6)), toBN(1E6))
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(init_estimated_assets.add(toBN(2000).mul(toBN(1E6))), toBN(1E6))
        await primaryStrategy.forceClose(position, {from: governance})
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(init_estimated_assets.add(toBN(2000).mul(toBN(1E6))), toBN(1E6))
        const estimated_assets = await primaryStrategy.estimatedTotalAssets();

        // run harvest
        await expect(usdcAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.fulfilled;
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0))
        // we should have the same position
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(estimated_assets.add(toBN(amount).mul(toBN(1E6))), toBN(1E6))
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })
  })

  // Adjusting the position by adding and removing assets - can be done during harvest events (adding credit) or withdrawals
  describe('Adjusting position', function () {
    beforeEach(async function () {
        const amount = '10000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance})
    })


    it('Should take on more debt and hold more colateral when adding to the positions', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add assets to usdcAdaptor
        await setBalance('usdc', usdcAdaptor.address, '10000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        const collId = (await primaryStrategy.getPosition(position)).collId
        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collId").that.eql(collId);
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        // the debt and collateral should both have increased
        assert.isAbove(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
        await expect(primaryStrategy.getPosition(position)).to.eventually.have.property("collId").that.not.eql(collId);
        const new_collId = (await primaryStrategy.getPosition(position)).collId

        await expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collId").that.not.eql(collId);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collId").that.eql(new_collId);
    })

    it('Should limit the amount the position is adjusted by depending on the borrow limit', async () => {
        const position = await primaryStrategy.activePosition();
        // set a borrow limit of 1M
        const borrowLimit = toBN(1E5).mul(toBN(1E6))
        await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

        // add 1M to usdcAdaptor
        await setBalance('usdc', usdcAdaptor.address, '100000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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

        await setBalance('usdc', usdcAdaptor.address, '10000');
        // add to position
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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

        await setBalance('usdc', usdcAdaptor.address, '10000');
        // try adding to position
        await usdcAdaptor.strategyHarvest(0, {from: governance})
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

        const initUserusdc = await usdc.balanceOf(investor1);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const amount = toBN(3000).mul(toBN(1E6))
        await usdcAdaptor.withdraw(amount, 1000, {from:investor1});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // position remains the same
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
        // withdrawer should have more usdc
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserusdc);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    // if vault debts to the strategy increases, the strategy should try to unwind the position to pay these back
    it('Should be posible to pay back debt to the vault', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        const stratData = await usdcAdaptor.strategies(primaryStrategy.address);
        // set new debtRatio to 70%
        const expected = await primaryStrategy.expectedReturn();
        await usdcAdaptor.setDebtRatio(primaryStrategy.address, 7000, {from: governance});

        const initVaultusdc = await usdc.balanceOf(usdcAdaptor.address);
        return expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(expected);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const amount = toBN(3000).mul(toBN(1E6))
        await usdcAdaptor.withdraw(amount, 1000, {from:investor1});

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // adaptor should have more usdc
        await expect(usdc.balanceOf(usdcAdaptor)).to.eventually.be.a.bignumber.gt(initVaultusdc);
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
        const initUserusdc = await usdc.balanceOf(investor1);
        const amount = toBN(7750).mul(toBN(1E6)) // ~ 79.5% of the position
        await usdcAdaptor.withdraw(amount, 1000, {from:investor1});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(position));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserusdc);
        // position debt and collateral has decreased
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should close position if withdrawing more than 80% of position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserusdc = await usdc.balanceOf(investor1);
        const amount = toBN(8500).mul(toBN(1E6))
        await usdcAdaptor.withdraw(amount, 5, {from:investor1});

        // position is closed
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        // withdrawer has more usdc
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserusdc);
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
        const initUserusdc = await usdc.balanceOf(investor1);
        const amount = toBN(4000).mul(toBN(1E6))
        await usdcAdaptor.withdraw(amount, 1000, {from:investor1});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(initUserusdc);
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('long/short adjustments', function () {
    beforeEach(async function () {
        const amount = '100000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance})
        await primaryStrategy.setStrategyThresholds(400, 10, 100, 5000, {from: governance});
    })

    it('Should be possible to adjust a long position towards a market netural position', async () => {
        const sid = await snapshotChain();
        await usdc.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})

        // first harvest
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initExposure = await primaryStrategy.getExposure();
        //await expect(usdcAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        // Not overexposed
        assert.equal(initExposure[0], false);
        assert.equal(initExposure[1], false);
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        let _assets = await primaryStrategy.estimatedTotalAssets();
        let _avax = await web3.eth.getBalance(primaryStrategy.address);

        let change;
        const large_number = toBN(1E4).mul(toBN(1E18));
        // simulate swaps
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(large_number, [tokens.avax.address, tokens.usdc.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        // increase the il threshold to stop the position from closing
        // should now tend towards market neutral during each harvest
        await primaryStrategy.setStrategyThresholds(800, 5, 100, 5000, {from: governance});
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
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        // should have avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(_avax);
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        currentPos = await primaryStrategy.activePosition();

        // still over exposed and long
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(150E6));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we are overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        await expect(lastExposure[2][1]).to.be.a.bignumber.lt(currentExposure);
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        // second harvest - sells off all avax, adjust the position (depending on minWant threshold)
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        // should have less avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.lt(_avax);
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        // still over exposed and long
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(150E6));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we are overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        // exposure should be less
        await expect(lastExposure[2][1]).to.be.a.bignumber.closeTo(currentExposure, toBN(20E6));
        currentExposure = lastExposure[2][1];

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        // third harvest, should have reduced the exposure below limit
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // should still have some avax left
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(toBN(0));
        _avax = await web3.eth.getBalance(primaryStrategy.address);

        lastExposure = await primaryStrategy.getExposure();

        // we're not over exposed anymore but will still have
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(150E6));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we arent overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));

        // should still have some avax to sell
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;

        // forth harvest
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // should have sold all avax
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        lastExposure = await primaryStrategy.getExposure();
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(_assets, toBN(150E6));
        _assets = await primaryStrategy.estimatedTotalAssets();

        // check that we arent overexposure (this manually calculates overexposure)
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        return revertChain(sid);
    })

    it('Should not open up a new position when holding more than 1 AVAX', async () => {
        const sid = await snapshotChain();
        await usdc.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        const initExposure = await primaryStrategy.getExposure();
        let change;
        const large_number = toBN(1E4).mul(toBN(1E18));
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(large_number, [tokens.avax.address, tokens.usdc.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await primaryStrategy.setStrategyThresholds(800, 1, 100, 5000, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();

        // give more avax to the strategy to ensure we have > 1 avax
        await web3.eth.sendTransaction({to: primaryStrategy.address, from: accounts[0], value: toWei('200', 'ether')})

        // we should have an active position
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        // we close it
        await primaryStrategy.forceClose((await primaryStrategy.activePosition()).toString(), {from: governance});
        // active position should be 0
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        let avaxBal = await web3.eth.getBalance(primaryStrategy.address)

        // harvest shouldnt open a position
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.lt(avaxBal);
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        lastExposure = await primaryStrategy.getExposure();
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        // we should have sold of enough avax to open a position
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        lastExposure = await primaryStrategy.getExposure();
        // we are still over exposed, so need to run another harvest cycle to get close enough market netural
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())));
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});

        return revertChain(sid);
    })

    it('Should be possible to adjust a short position towards a market netural position', async () => {
        const sid = await snapshotChain();
        await usdc.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});

        const amount = '100000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();

        const initExposure = await primaryStrategy.getExposure();
        //await expect(usdcAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        // Not overexposed
        assert.equal(initExposure[0], false);
        assert.equal(initExposure[1], false);
        let _assets = await primaryStrategy.estimatedTotalAssets();

        let change;
        const large_number = toBN(1E6).mul(toBN(1E6));
        while (true) {
            await setBalance('usdc', investor1, '1000000');
            await swap(large_number, [tokens.usdc.address, tokens.avax.address])
            change = await primaryStrategy.volatilityCheck();
            // once were above a 4% price change
            if (change == true) break;
        }

        // increase the il threshold to stop the position from closing
        // should now tend towards market neutral during each harvest
        await primaryStrategy.setStrategyThresholds(800, 5, 100, 5000, {from: governance});
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
        await usdcAdaptor.strategyHarvest(0, {from: governance});
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
        await usdcAdaptor.strategyHarvest(0, {from: governance});
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
        await usdcAdaptor.strategyHarvest(0, {from: governance});

        lastExposure = await primaryStrategy.getExposure();

        // over exposed and short
        assert.equal(lastExposure[0], true);
        assert.equal(lastExposure[1], true);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.lt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.true;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        // forth harvest
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        lastExposure = await primaryStrategy.getExposure();
        assert.equal(lastExposure[0], false);
        assert.equal(lastExposure[1], false);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(_assets);
        _assets = await primaryStrategy.estimatedTotalAssets();
        await expect(primaryStrategy.exposureThreshold()).to.eventually.be.a.bignumber.gt(toBN(lastExposure[3]).mul(toBN(1E4)).div(toBN(lastExposure[4][0].toString())).mul(toBN(-1)));

        await expect(primaryStrategy.harvestTrigger(0)).to.eventually.be.false;
        trigger = await primaryStrategy.harvestTrigger(0, {from: governance});
        return revertChain(sid);
    })
  })

  describe('Assets interactions', function () {
    beforeEach(async function () {
        await usdc.approve(router, constants.MAX_UINT256, {from: investor1});
        await sushi.approve(router, constants.MAX_UINT256, {from: investor1});
        await avax.approve(router, constants.MAX_UINT256, {from: investor1});
    })

    // Should be able to see how much sushi we are expecting
    it('Should correctly estimated sushi assets', async () => {
        const sid = await snapshotChain();
        await setBalance('usdc', usdcAdaptor.address, '100000');
        await usdcAdaptor.strategyHarvest(0, {from: governance});
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
        await setBalance('usdc', usdcAdaptor.address, '10000');
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await masterChef.methods.updatePool(poolID).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        for (let i = 0; i < 1000; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(poolID).send({from: governance});
        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        let change;
        const larget_number = toBN(1E4).mul(toBN(1E18));
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(larget_number, [tokens.avax.address, tokens.usdc.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // revert the swap
        const userWant = await usdc.balanceOf(investor1);
        await swap(userWant, [tokens.usdc.address, tokens.avax.address])
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        await network.provider.send("evm_mine");
        // eth and sushi sold off
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.eq(toBN(0));
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(0), toBN(1E15));

        return revertChain(sid);
    })

    // should be able to estiamte totalAsset changes
    it('Should estimate totalAssets', async () => {
        const sid = await snapshotChain();
        const amount = '10000'
        await setBalance('usdc', usdcAdaptor.address, amount);
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const _assets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await usdc.balanceOf(primaryStrategy.address);
        await setBalance('usdc', primaryStrategy.address, amount);
        // expect totalAssets
        const expected = toBN(amount).mul(toBN(1E6)).sub(reserves).add(_assets);
        // estimated totalAssets
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.equal(expected);
        // update sushi rewards
        await masterChef.methods.updatePool(poolID).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        // pass 10 blocks
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        // expected total assets without sushi rewards...
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expected);
        const expectedNoSushi = await primaryStrategy.estimatedTotalAssets();
        await masterChef.methods.updatePool(poolID).send({from: governance});
        // ..should be lower than when we updated the rewards
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expectedNoSushi);
    })

    // Simulate changes in expected return
    it('Should estimate expected return', async () => {
        const sid = await snapshotChain();
        const initPosition = await primaryStrategy.activePosition();
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.equal(toBN(0));
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const expected = await primaryStrategy.expectedReturn();
        const alphaData = await homoraBank.methods.getPositionInfo(initPosition).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(initPosition).call()
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // Expect position expected return to be 0
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.eq(toBN(0));
        const stratData = await usdcAdaptor.strategies(primaryStrategy.address);
        const position = await primaryStrategy.activePosition();
        const alphaDataPre = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtPre = await homoraBank.methods.getPositionDebts(position).call()
        const amount = '200000'
        const _assets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await usdc.balanceOf(primaryStrategy.address);
        // add "profit" to strategy
        // await setBalance('usdc', primaryStrategy.address, amount);
        // should report more asssets and more expected returns
        // await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(_assets);
        // await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(expected);
        const preSwap = await primaryStrategy.expectedReturn();
        const large_number = toBN(1E5).mul(toBN(1E18));
        let change;
        // simulate swaps
        while (true) {
            await setBalance('avax', investor1, '100000');
            await swap(large_number, [tokens.avax.address, tokens.usdc.address])
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        // revert the swap to neutral
        const userusdc = await usdc.balanceOf(investor1);
        await swap(userusdc, [tokens.usdc.address, tokens.avax.address]);
        await network.provider.send("evm_mine");
        // should now have additional gains from swapping fee and sushi tokens
        for (let i = 0; i < 100; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(poolID).send({from: governance});
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.gt(preSwap);
        const preHarvestProfit = (await usdcAdaptor.strategies(primaryStrategy.address)).totalGain;
        const expectedPreHarvest = await primaryStrategy.expectedReturn();
        // harvest gains
        const pricePerShare = await usdcVault.getPricePerShare();
        await primaryStrategy.forceClose(position, {from: governance})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(usdcVault.getPricePerShare()).to.eventually.be.a.bignumber.equal(pricePerShare);
        for (let i = 0; i < 100; i++) {
          await network.provider.send("evm_mine");
        }
        await expect(usdcVault.getPricePerShare()).to.eventually.be.a.bignumber.gt(pricePerShare);
        const alphaDataFin = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtFin = await homoraBank.methods.getPositionDebts(position).call()

        // expectedReturn should be back at 0
        await expect(usdcAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.eq(toBN(0));

        return revertChain(sid);
    })
  })

  describe("Setters", function () {

    it('Should be possible to change the minWant', async () => {
        const originalWant = await primaryStrategy.minWant();
        await expect(originalWant).to.be.a.bignumber.equal(toBN(100000000));
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
        const amount_norm_usdc = toBN(amount).mul(toBN(1E6));
        const amount_norm_weth = toBN(amount).mul(toBN(1E18));
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(amount_norm_usdc, {from: investor1})
        await primaryStrategy.setAmmThreshold(usdc.address, 0, {from: governance});
        await expect(usdcAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.rejectedWith('!ammCheck');
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.eq(toBN(0));
        await primaryStrategy.setAmmThreshold(usdc.address, 500, {from: governance});
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        const position = await primaryStrategy.activePosition()
        // force close the position
        await primaryStrategy.setAmmThreshold(usdc.address, 0, {from: governance});
        //await expect(primaryStrategy.forceClose(position, {from: governance})).to.eventually.be.rejectedWith('_closePosition: !ammCheck');
        await primaryStrategy.setAmmThreshold(usdc.address, 200, {from: governance});
        await primaryStrategy.setStrategyThresholds(0, 10, 50, 5000, {from: governance});

        await primaryStrategy.setAmmThreshold(sushiToken, 0, {from: governance});
        return expect(usdcAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.rejectedWith('!ammCheck');
    })

    it('Should be possible to get positionData', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        const pos = await primaryStrategy.activePosition();
        return expect(primaryStrategy.getPosition(pos)).to.eventually.have.property("collateral").that.is.a.bignumber.gt(toBN("0"));
    })

    it('Should be return 0 when calling calcEstimatedWant if theres no open position', async () => {
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        return expect(primaryStrategy.calcEstimatedWant()).to.eventually.be.a.bignumber.equal(toBN(0));
    })

    it('Should be return false when calling volatilityCheck if theres no open position', async () => {
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        return expect(primaryStrategy.volatilityCheck()).to.eventually.be.false;
    })

    it('Should be return false when calling tendTrigger', async () => {
        return expect(primaryStrategy.tendTrigger(0)).to.eventually.be.false;
    })

    it('Should be possible to migrate a strategy', async () => {
        const newStrat= await AHStrategy.new(usdcVault.address, sushiSpell, router, pool, poolID, [tokens.usdc.address, tokens.avax.address], ZERO);
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        await expect(usdcAdaptor.migrateStrategy(primaryStrategy.address, newStrat.address, {from: governance})).to.eventually.be.rejectedWith('active position');
        await primaryStrategy.forceClose(await primaryStrategy.activePosition(), {from: governance});
        return expect(usdcAdaptor.migrateStrategy(primaryStrategy.address, newStrat.address, {from: governance})).to.eventually.be.fulfilled;
    })

    it('Should be possible to pull out all assets through an emergency exit', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        await primaryStrategy.setEmergencyExit({from: governance});
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(toBN(1E6));
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // some leftover assets are acceptable
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(toBN(1E6));
    })

    it('Should be possible to repay debt to the vault', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(toBN(1E6));
        await usdcAdaptor.setDebtRatio(primaryStrategy.address, 6000, {
          from: governance,
        });
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(toBN('6000').mul(toBN(1E6)), toBN(1E6));
        await usdcAdaptor.setDebtRatio(primaryStrategy.address, 0, {
          from: governance,
        });
        debts = await homoraBank.methods.getPositionDebts(await primaryStrategy.activePosition()).call()
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        // some leftover assets are acceptable
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(toBN(1E6));
    })

    it('Should be possible to repay debt to the vault even when it wants to close', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(toBN(1E6));

        await usdcAdaptor.setDebtRatio(primaryStrategy.address, 6000, {
          from: governance,
        });
        await primaryStrategy.setStrategyThresholds(0, 10, 50, 5000, {from: governance});
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(toBN('6000').mul(toBN(1E6)), toBN(1E6));
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.closeTo(toBN(4000).mul(toBN(1E6)), toBN(1E6));
        await usdcAdaptor.setDebtRatio(primaryStrategy.address, 0, {
          from: governance,
        });
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(usdc.balanceOf(usdcAdaptor.address)).to.eventually.be.a.bignumber.closeTo(toBN(10000).mul(toBN(1E6)), toBN(1E6));
        // some leftover assets are acceptable
        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(toBN(1E6));
    })

    it('Should report loss correctly', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await primaryStrategy.setBorrowLimit(toBN('8000').mul(toBN(1E6)), {from: governance});
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(2000).mul(toBN(1E6)), toBN(1E6));
        await setBalance('usdc', primaryStrategy.address, '0');

        await usdcAdaptor.withdraw(toBN(1900).mul(toBN(1E6)), 10000, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(toBN(0));
        await usdcAdaptor.withdraw(toBN(2000).mul(toBN(1E6)), 1000, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(toBN(0));
        const investor_balance = await usdc.balanceOf(investor1);
        await usdcAdaptor.withdraw(toBN(200).mul(toBN(1E6)), 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(investor_balance);
        const investor_balance_2 = await usdc.balanceOf(investor1);

        // withdrawal from loose assets in strategy
        await primaryStrategy.forceClose(await primaryStrategy.activePosition(), {from: governance});
        await usdcAdaptor.withdraw(toBN(200).mul(toBN(1E6)), 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(investor_balance_2);
        await usdcAdaptor.withdraw(constants.MAX_UINT256, 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.closeTo(toBN('8000').mul(toBN(1E6)), toBN(1E6));

        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(toBN(1E6));
    })

    it('Should report loss correctly part 2', async () => {
        await setBalance('usdc', investor1, '10000');
        await usdcAdaptor.deposit(toBN('10000').mul(toBN(1E6)), {from: investor1})
        await primaryStrategy.setBorrowLimit(toBN('8000').mul(toBN(1E6)), {from: governance});
        await usdcAdaptor.strategyHarvest(0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        await expect(usdc.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(2000).mul(toBN(1E6)), toBN(1E6));
        await setBalance('usdc', primaryStrategy.address, '0');

        await usdcAdaptor.withdraw(toBN(1900).mul(toBN(1E6)), 10000, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.equal(toBN(0));
        await usdcAdaptor.withdraw(toBN(2000).mul(toBN(1E6)), 1000, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(toBN(0));
        const investor_balance = await usdc.balanceOf(investor1);
        await usdcAdaptor.withdraw(toBN(200).mul(toBN(1E6)), 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(investor_balance);
        const investor_balance_2 = await usdc.balanceOf(investor1);

        // withdrawal from active position
        await usdcAdaptor.withdraw(toBN(1000).mul(toBN(1E6)), 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.gt(investor_balance_2);
        await usdcAdaptor.withdraw(constants.MAX_UINT256, 100, {from:investor1});
        await expect(usdc.balanceOf(investor1)).to.eventually.be.a.bignumber.closeTo(toBN('8000').mul(toBN(1E6)), toBN(1E6));

        return expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.lt(toBN(1E6));
    })
  })
})
