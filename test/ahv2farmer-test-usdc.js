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

contract('Alpha homora test', function (accounts) {
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
    usdcAdaptor = await VaultAdaptor.new(tokens.usdc.address, bouncer, { from: governance });
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
    await web3.eth.sendTransaction({to: AHGov, from: accounts[0], value: toWei('1', 'ether')})
    await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov})
    await homoraBank.methods.setCreditLimits([[primaryStrategy.address, avax.address, toBN(1E18).mul(toBN(1E18)).toString()]]).send({from: AHGov})
    await usdcAdaptor.addToWhitelist(governance, {from: governance});
    await primaryStrategy.setMinWant(100, {from: governance});

    await usdcAdaptor.setDepositLimit(constants.MAX_UINT256, {from: governance});
    await usdc.approve(usdcAdaptor.address, allowance, {from: investor1});
    await usdcAdaptor.setUserAllowance(investor1, allowance, {from: bouncer});
    await usdc.approve(usdcAdaptor.address, constants.MAX_UINT256, {from: investor2});
    await usdcAdaptor.setUserAllowance(investor2, allowance, {from: bouncer});

    await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));

        // the estimated assets should be ~ 2M but the position size <= 1M
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.closeTo(deposit_norm, toBN(1E18));
        return expect(primaryStrategy.calcEstimatedWant()).to.eventually.be.a.bignumber.lte(borrowLimit);
    })

    // Check that we can add assets to a position
    it('Should be possible to add to a position', async () => {
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add 1 M usdc to adaper
        await setBalance('usdc', usdcAdaptor.address, '10000');
        // run harvest
        await expect(usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})).to.eventually.be.fulfilled;
        // we should have the same position
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })
  })

  // Given an existing positon, it should be possible to close it at will, or through calling
  // harvest/tend, given a specific set of circumstances.
  describe('Closing position', function () {
    beforeEach(async function () {
        const amount = '100000';
        await setBalance('usdc', primaryStrategy.address, amount);
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
    })

    it('Should be possible to force close a position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        // There should be a position with debt and collateral
        assert.isAbove(Number(alphaDebt['debts'][0]), 0);
        assert.isAbove(Number(alphaData['collateralSize']), 0);

        // force close the position
        await primaryStrategy.forceClose(position, 0, 0, {from: governance});
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
  })

  // Adjusting the position by adding and removing assets - can be done during harvest events (adding credit) or withdrawals
  describe('Adjusting position', function () {
    beforeEach(async function () {
        const amount = '10000';
        await setBalance('usdc', investor1, amount);
        await usdcAdaptor.deposit(toBN(amount).mul(toBN(1E6)), {from: investor1})
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
    })


    it('Should take on more debt and hold more colateral when adding to the positions', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        // add assets to usdcAdaptor
        await setBalance('usdc', usdcAdaptor.address, '10000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
        const borrowLimit = toBN(1E5).mul(toBN(1E6))
        await primaryStrategy.setBorrowLimit(borrowLimit, {from: governance});

        // add 1M to usdcAdaptor
        await setBalance('usdc', usdcAdaptor.address, '100000');
        // adjust the position, should take on more debt as the collateral ratio is fine
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        const position = await primaryStrategy.activePosition();
        await masterChef.methods.updatePool(39).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(39).send({from: governance});
        return expect(primaryStrategy.pendingYieldToken(position)).to.eventually.be.a.bignumber.gt(initSushi);
    })

    // Sell assets
    it('Should correctly sell of eth and sushi', async () => {
        const sid = await snapshotChain();
        await setBalance('usdc', usdcAdaptor.address, '10000');
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()

        await masterChef.methods.updatePool(39).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        for (let i = 0; i < 1000; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(39).send({from: governance});
        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        let change;
        const larget_number = toBN(1E4).mul(toBN(1E18));
        while (true) {
            await setBalance('avax', investor1, '10000');
            await expect(swap(larget_number, [tokens.avax.address, tokens.usdc.address])).to.eventually.be.fulfilled;
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        // revert the swap
        const userWant = await usdc.balanceOf(investor1);
        await swap(userWant, [tokens.usdc.address, tokens.avax.address])
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        await network.provider.send("evm_mine");
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(initSushi);
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.gt(initEth);
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance})
        await expect(sushi.balanceOf(primaryStrategy.address)).to.eventually.be.a.bignumber.equal(toBN(0));
        await expect(web3.eth.getBalance(primaryStrategy.address)).to.eventually.be.a.bignumber.closeTo(toBN(0), toBN(1E15));

        return revertChain(sid);
    })

    // should be able to estiamte totalAsset changes
    it('Should estimate totalAssets', async () => {
        const sid = await snapshotChain();
        const amount = '100000'
        await setBalance('usdc', usdcAdaptor.address, amount);
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        const position = await primaryStrategy.activePosition();
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await usdc.balanceOf(primaryStrategy.address);
        await setBalance('usdc', primaryStrategy.address, amount);
        // expect totalAssets
        const expected = toBN(amount).mul(toBN(1E6)).sub(reserves).add(initAssets);
        // estimated totalAssets
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.equal(expected);
        // update sushi rewards
        await masterChef.methods.updatePool(39).send({from: governance});
        const initSushi =  await primaryStrategy.pendingYieldToken(position);
        // pass 10 blocks
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        // expected total assets without sushi rewards...
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expected);
        const expectedNoSushi = await primaryStrategy.estimatedTotalAssets();
        await masterChef.methods.updatePool(39).send({from: governance});
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
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        const expected = await primaryStrategy.expectedReturn();
        const alphaData = await homoraBank.methods.getPositionInfo(initPosition).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(initPosition).call()
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        // Expect position expected return to be 0
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.eq(toBN(0));
        const stratData = await usdcAdaptor.strategies(primaryStrategy.address);
        const position = await primaryStrategy.activePosition();
        const alphaDataPre = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtPre = await homoraBank.methods.getPositionDebts(position).call()
        const amount = '200000'
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await usdc.balanceOf(primaryStrategy.address);
        // add "profit" to strategy
        // await setBalance('usdc', primaryStrategy.address, amount);
        // should report more asssets and more expected returns
        // await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(initAssets);
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
        await primaryStrategy.forceClose(position, 0, 0, {from: governance})
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        await expect(usdcVault.getPricePerShare()).to.eventually.be.a.bignumber.gt(pricePerShare);
        const alphaDataFin = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtFin = await homoraBank.methods.getPositionDebts(position).call()

        // expectedReturn should be back at 0
        await expect(usdcAdaptor.strategies(primaryStrategy.address)).to.eventually.have.property("totalGain").that.is.a.bignumber.gt(preHarvestProfit);
        await expect(primaryStrategy.expectedReturn()).to.eventually.be.a.bignumber.lt(expectedPreHarvest);

        return revertChain(sid);
    })
  })

  describe("Setters", function () {

    it('Should be possible to change the minWant', async () => {
        const originalWant = await primaryStrategy.minWant();
        await expect(originalWant).to.be.a.bignumber.equal(toBN(100));
        await primaryStrategy.setMinWant(200, {from: governance});
        return expect(primaryStrategy.minWant()).to.eventually.be.a.bignumber.equal(toBN(200));
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
        return expect(primaryStrategy.setIlThreshold(100)).to.eventually.be.rejected;
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
        await expect(usdcAdaptor.strategyHarvest(0, amount_norm_usdc, amount_norm_weth, {from: governance})).to.eventually.be.rejected;
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.eq(toBN(0));
        await usdcAdaptor.strategyHarvest(0, 0, 0, {from: governance});
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        const position = primaryStrategy.activePosition()
        // force close the position
        return expect(primaryStrategy.forceClose(position, amount_norm_usdc, amount_norm_weth, {from: governance})).to.eventually.be.rejected;
    })
  })
})
