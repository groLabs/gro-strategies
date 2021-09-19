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
const mainnet = process.env['mainnet']

const abiDecoder = require('abi-decoder');

const sushiSpell = '0xc4a59cfEd3FE06bDB5C21dE75A70B20dB280D8fE'
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
    investor2,
    blockNo;

abiDecoder.addABI(spellSushiABI);
abiDecoder.addABI(homoraABI);

async function getData(data) {
        const decodedData = abiDecoder.decodeMethod(data);
        const position = decodedData.params[0]['value']
        const spell = decodedData.params[1]['value']
        const payload = decodedData.params[2]['value']
        return [position, spell, payload]

}

async function encode(userAmount, spell) {
        borrowAmount = await uni.methods.getAmountsOut(userAmount, path).call()
        minAmounts = []
        minAmounts[0] = toBN(borrowAmount[0]).mul(toBN(9999)).div(toBN(10000))
        minAmounts[1] = toBN(borrowAmount[1]).mul(toBN(9999)).div(toBN(10000))
    amt = [
                borrowAmount[0],
                '0',
                '0',
                '0',
                borrowAmount[1],
                '0',
                minAmounts[0].toString(),
                minAmounts[1].toString(),

    ]

        data = await spell.methods.addLiquidityWERC20(dai._address, weth, amt).encodeABI()
        return data;
}

async function swap(amount, path) {
    const deadline = (await web3.eth.getBlockNumber().then(res => web3.eth.getBlock(res))).timestamp
    console.log('------swap');
    console.log(amount.toString());
    console.log(await dai.balanceOf(investor1).then(res=>res.toString()));
    console.log(await dai.allowance(investor1, router).then(res=>res.toString()));
    const change = await sushiSwapRouter.methods.getAmountsOut(amount, path).call();
    console.log('change ' + change[0])
    console.log('change ' + change[1])
    await sushiSwapRouter.methods.swapExactTokensForTokens(
        change[0],
        change[1],
        path,
        investor1,
        deadline + 1000
    ).send({from: investor1});
}

contract('Alpha homora test', function (accounts) {
  admin = accounts[0]
  governance = accounts[1]
  investor1 = accounts[8]
  investor2 = accounts[9]
  amount = new BN(10000)
  console.log(admin)
  console.log(governance)

  beforeEach(async function () {

    homoraBank = await new web3.eth.Contract(homoraABI, proxyHomora);
    spellSushi = await new web3.eth.Contract(spellSushiABI, sushiSpell);
    masterChef = await new web3.eth.Contract(masterChefABI, chef);
    sushiSwapRouter = await new web3.eth.Contract(uniABI, router);

    await hre.network.provider.request(
        {
            method: "hardhat_impersonateAccount",
            params: [AHGov]
        }
    )

    dai = await MockERC20.at(tokens.dai.address);
    weth = await MockERC20.at(tokens.weth.address);
    sushi = await MockERC20.at(sushiToken);
    mockController = await MockController.new();
    mockInsurance = await MockInsurance.new();
    mockPnL = await MockPnL.new();
    await mockController.setInsurance(mockInsurance.address);
    await mockController.setPnL(mockPnL.address);

    daiAdaptor = await VaultAdaptor.new(tokens.dai.address, { from: governance });
    daiVault = daiAdaptor;
    await daiAdaptor.setController(mockController.address, { from: governance });

    primaryStrategy = await AHStrategy.new(daiVault.address, sushiSpell, router, pool, poolID);
    await primaryStrategy.setKeeper(daiAdaptor.address, {from: governance});
    const botLimit = toBN(0)
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));
    await daiVault.addStrategy(
      primaryStrategy.address,
      10000,
      botLimit, topLimit,
      { from: governance }
    )

    secondaryStrategy = await TestStrategy.new(daiVault.address)
    await secondaryStrategy.setKeeper(daiAdaptor.address, {from: governance});
    await daiVault.addStrategy(
      secondaryStrategy.address,
      0,
      botLimit, topLimit,
      { from: governance }
    )

    await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov})
    await daiAdaptor.addToWhitelist(governance, {from: governance});
    blockNo = await web3.eth.getBlockNumber()
  })

  describe("Opening position", function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
    })

    it('Should be possible to open up a position in AHv2', async () => {
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.gt(toBN(0));
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        console.log(JSON.stringify(alphaData));
        assert.strictEqual(alphaData['owner'], primaryStrategy.address);
    })

    it('Should be possible to add to a position', async () => {
        await daiAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        await setBalance('dai', daiAdaptor.address, '1000000');
        await expect(daiAdaptor.strategyHarvest(0, {from: governance})).to.eventually.be.fulfilled;
        return expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);
    })

    it('Should be possible to force close a position', async () => {
        await daiAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));
        assert.isAbove(Number(alphaDebt['debts'][0]), 0);
        assert.isAbove(Number(alphaData['collateralSize']), 0);

        await primaryStrategy.panicClose(position, {from: governance});
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtClose));
        console.log(JSON.stringify(alphaDataClose));
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('Closing position', function () {
    beforeEach(async function () {
        await setBalance('dai', primaryStrategy.address, '100000000');
    })

    it('Should close the position if the price has diviated with more than 5%', async () => {
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await weth.approve(router, constants.MAX_UINT256, {from: investor1});
        await daiAdaptor.strategyHarvest(0, {from: governance})
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        console.log('il ' + await primaryStrategy.volatilityCheck());
        const larget_number = toBN(1E6).mul(toBN(1E18));
        let change;
        while (true) {
            await setBalance('dai', investor1, '1000000');
            await swap(larget_number, [tokens.dai.address, tokens.weth.address])
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await daiAdaptor.strategyHarvest(0, {from: governance})
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtClose));
        console.log(JSON.stringify(alphaDataClose));
        // revert the swap
        const userWant = await weth.balanceOf(investor1);
        await swap(userWant, [tokens.weth.address, tokens.dai.address])
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('Adjusting position', function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
    })

    it('Should take on more debt and hold more colateral when adding to the positions', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtAdd));
        console.log(JSON.stringify(alphaDataAdd));
        assert.isAbove(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should not take on more debt when adding if above target collateral factor', async () => {
        await setStorageAt(
            primaryStrategy.address,
            ethers.utils.hexValue(9),
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        await
        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(position);

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtAdd));
        console.log(JSON.stringify(alphaDataAdd));
        assert.strictEqual(Number(alphaDebtAdd['debts'][0]), Number(alphaDebt['debts'][0]));
        assert.isAbove(Number(alphaDataAdd['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should close the position if above collateral threshold when adding assets', async () => {
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
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataAdd = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtAdd = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtAdd));
        console.log(JSON.stringify(alphaDataAdd));
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should be posible to remove assets from a position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        const initUserDai = await dai.balanceOf(governance);
        // simulate withdrawal from AHv2 strategy via vaultAdapter
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(30000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        console.log('dai amount post ' + await dai.balanceOf(governance))
        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtRemove));
        console.log(JSON.stringify(alphaDataRemove));
        console.log('init ' + initUserDai.toString())
        console.log('post ' + (await dai.balanceOf(governance)).toString())
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        assert.isBelow(Number(alphaDebtRemove['debts'][0]), Number(alphaDebt['debts'][0]));
        return assert.isBelow(Number(alphaDataRemove['collateralSize']), Number(alphaData['collateralSize']));
    })

    it('Should close position if withdrawing more than 90% of position', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserDai = await dai.balanceOf(governance);
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(8500000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtRemove));
        console.log(JSON.stringify(alphaDataRemove));
        console.log('init ' + initUserDai.toString())
        console.log('post ' + (await dai.balanceOf(governance)).toString())
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })

    it('Should close the position if collateral ratio is above threshold when withdrawing', async () => {
        console.log(await web3.eth.getStorageAt(primaryStrategy.address, 9))
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
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        // simulate withdrawal from AHv2 strategy via vaultAdapter
        const initUserDai = await dai.balanceOf(governance);
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(40000).mul(toBN(1E18))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});

        await expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));

        const alphaDataRemove = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtRemove = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtRemove));
        console.log(JSON.stringify(alphaDataRemove));
        console.log('init ' + initUserDai.toString())
        console.log('post ' + (await dai.balanceOf(governance)).toString())
        await expect(dai.balanceOf(governance)).to.eventually.be.a.bignumber.gt(initUserDai);
        await expect(homoraBank.methods.getPositionDebts(position).call()).to.eventually.have.property("debts").that.eql([]);
        return expect(homoraBank.methods.getPositionInfo(position).call()).to.eventually.have.property("collateralSize").that.eql("0");
    })
  })

  describe('Assets interactions', function () {
    beforeEach(async function () {
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await weth.approve(router, constants.MAX_UINT256, {from: investor1});
        await setBalance('dai', daiAdaptor.address, '100000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
    })

    it('Should correctly estimated sushi assets', async () => {
        const position = await primaryStrategy.activePosition();
        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi();
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        console.log('sushi amount post 10 blocks ' + await primaryStrategy.pendingSushi())
        return expect(primaryStrategy.pendingSushi()).to.eventually.be.a.bignumber.gt(initSushi);
    })

    it.only('Should correctly sell of eth and sushi', async () => {
        const position = await primaryStrategy.activePosition();
        const alphaData = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebt = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebt));
        console.log(JSON.stringify(alphaData));

        console.log('il ' + await primaryStrategy.volatilityCheck());
        const larget_number = toBN(1E6).mul(toBN(1E18));
        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi();
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        const initEth = await web3.eth.getBalance(primaryStrategy.address);
        let change;
        while (true) {
            await setBalance('weth', investor1, '1000000');
            await swap(larget_number, [tokens.weth.address, tokens.dai.address])
            change = await primaryStrategy.volatilityCheck();
            if (change == true) break;
        }
        await daiAdaptor.strategyHarvest(0, {from: governance})
        expect(primaryStrategy.activePosition()).to.eventually.be.a.bignumber.equal(toBN(0));
        const alphaDataClose = await homoraBank.methods.getPositionInfo(position).call()
        const alphaDebtClose = await homoraBank.methods.getPositionDebts(position).call()
        console.log(JSON.stringify(alphaDebtClose));
        console.log(JSON.stringify(alphaDataClose));
        const postSushi =  await sushi.balanceOf(primaryStrategy.address);
        const postEth = await web3.eth.getBalance(primaryStrategy.address);
        // revert the swap
        const userDai = await dai.balanceOf(investor1);
        await swap(userDai, [tokens.dai.address, tokens.weth.address])
        console.log('init eth ' + initEth)
        console.log('post eth ' + postEth)
        console.log('init sushi ' + initSushi);
        console.log('post sushi ' + postSushi);
    })

    it.only('Should estimate totalAssets', async () => {
        const amount = '100000'
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await dai.balanceOf(primaryStrategy);
        await setBalance('dai', primaryStrategy.address, amount);
        const expected = toBN(amount).mul(toBN(1E18)).sub(reserves);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.equal(expect);
        await masterChef.methods.updatePool(2).send({from: governance});
        const initSushi =  await primaryStrategy.pendingSushi();
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expect);
    })

    it('Should estimate expected return', async () => {
        const expected = await primaryStrategy.expectedReturn();
        const stratData = await daiAdaptor.strategies(primaryStrategy.address);
        console.log(JSON.stringify(stratData));
        console.log('expected ' + expected);
        assert.strictEqual(Number(expected), 0);
        const amount = '100000'
        const initAssets = await primaryStrategy.estimatedTotalAssets();
        const reserves = await dai.balanceOf(primaryStrategy);
        await setBalance('dai', primaryStrategy.address, amount);
        await expect(primaryStrategy.estimatedTotalAssets()).to.eventually.be.a.bignumber.gt(expected);
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
