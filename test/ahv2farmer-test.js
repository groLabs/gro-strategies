const MockController = artifacts.require('MockController')
const MockInsurance = artifacts.require('MockInsurance')
const MockPnL = artifacts.require('MockPnL')
const MockERC20 = artifacts.require('MockERC20')
const TestStrategy = artifacts.require('TestStrategy')
const AHStrategy = artifacts.require('AHv2Farmer')
const VaultAdaptor = artifacts.require('VaultAdaptorMK2')

const { toBN, BN } = web3.utils
const { constants } = require('./utils/constants');
const { expect, ZERO, tokens, setBalance } = require('./utils/common-utils');
const fs = require('fs');

const abiDecoder = require('abi-decoder');

const sushiSpell = '0xc4a59cfEd3FE06bDB5C21dE75A70B20dB280D8fE'
const router = '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F'
const pool = '0xC3D03e4F041Fd4cD388c549Ee2A29a9E5075882f'
const AHGov = '0xb593d82d53e2c187dc49673709a6e9f806cdc835'
const poolID = 2;

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
  })

  describe("Basic strategy logic", function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
    })

    it('Should be possible to open up a position in AHv2', async () => {
        console.log('ps: ' + primaryStrategy.address);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));

    })

    it('Should be possible to add to a position', async () => {
        console.log('ps: ' + primaryStrategy.address);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));

        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
        ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));
        var vals = await homoraBank.methods.getPositionInfo(ap).call()
        console.log('collSize ' + vals[3]);
        var debts = await homoraBank.methods.getPositionDebts(ap).call()
        console.log('debts' + JSON.stringify(debts[1]));
    })

    it('Should be possible to force close a position', async () => {
        console.log('ps: ' + primaryStrategy.address);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));

        var debts = await homoraBank.methods.getPositionDebts(ap).call()
        console.log('debts' + JSON.stringify(debts[1]));
        await primaryStrategy.panicClose({from: governance});
        console.log(JSON.stringify(posData));
    })
  })

  describe('Impermanent loss', function () {
    beforeEach(async function () {
        await dai.approve(router, constants.MAX_UINT256, {from: investor1});
        await weth.approve(router, constants.MAX_UINT256, {from: investor1});
        await setBalance('dai', primaryStrategy.address, '100000000');
    })

    it('Should close the position if the price has diviated with more than 5%', async () => {
        console.log('ps: ' + primaryStrategy.address);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));
        console.log('il ' + await primaryStrategy.volatilityCheck());
        const larget_number = toBN(1E6).mul(toBN(1E18));
        let change;
        let i = 0;
        while (true) {
            i += 1;
            console.log(i);
            await setBalance('dai', investor1, '1000000');
            await swap(larget_number, [tokens.dai.address, tokens.weth.address])
            change = await primaryStrategy.volatilityCheck();
            console.log(change);
            if (change == true) break;
        }
        await daiAdaptor.strategyHarvest(0, {from: governance})
        ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
    })
  })

  describe('deposit', function () {
  });

  describe("Withdrawal", function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
        console.log('ps: ' + primaryStrategy.address);
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));
    })

    it('Should be posible to withdraw from a position', async () => {
        await mockController.setInsurance(governance, {from: governance});
        const amount = toBN(10000).mul(toBN(1E18))

        console.log('dai amount pre ' + await dai.balanceOf(governance))
        await daiAdaptor.withdrawByStrategyIndex(amount, governance, 0, {from:governance});
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));
        console.log('dai amount post ' + await dai.balanceOf(governance))
    })
  })

  describe("totalEstimatedAssets", function () {
    it('Should be posible to withdraw from a position', async () => {
        console.log('ps: ' + primaryStrategy.address);

        await setBalance('dai', daiAdaptor.address, '1000000');
        await daiAdaptor.strategyHarvest(0, {from: governance})
        let ap = await primaryStrategy.activePosition();
        console.log('active pos: ' + ap);
        let posData = await primaryStrategy.getPosition();
        console.log(JSON.stringify(posData));
        console.log('ps ' + primaryStrategy.address)
        await masterChef.methods.updatePool(2).send({from: governance});
        console.log('sushi expected post ' + await primaryStrategy.pendingSushi())
        for (let i = 0; i < 10; i++) {
          await network.provider.send("evm_mine");
        }
        await masterChef.methods.updatePool(2).send({from: governance});
        console.log('sushi amount post 10 blocks ' + await primaryStrategy.pendingSushi())
    })
  })

  describe("setters", function () {
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
        await expect(originalIlThreshold).to.be.a.bignumber.equal(toBN(500));
        await primaryStrategy.setIlThreshold(100, {from: governance});
        return expect(primaryStrategy.ilThreshold()).to.eventually.be.a.bignumber.equal(toBN(100));
    })
  })

  describe("Utility", function () {
    it('Should be possible to get the strategy Name', async () => {
        return expect(primaryStrategy.name()).to.eventually.equal('Ahv2 strategy');
    })
  })
})
