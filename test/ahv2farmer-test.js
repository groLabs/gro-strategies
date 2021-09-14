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

contract('Alpha homora test', function (accounts) {
  const admin = accounts[0]
  const governance = accounts[1]
  const investor1 = accounts[8]
  const investor2 = accounts[9]
  const amount = new BN(10000)
  const zero = new BN(0)
  const decimal = new BN(10).pow(new BN(15))
  const daiBaseNum = new BN(10).pow(new BN(18))

  let daiAdaptor,
    mockController,
    mockInsurance,
    mockPnL,
    dai,
    sushi,
    daiVault,
    primaryStrategy,
    secondaryStrategy,
    homoraBank,
    spellSushi,
    masterChef;

  beforeEach(async function () {

    homoraBank = await new web3.eth.Contract(homoraABI, proxyHomora);
    spellSushi = await new web3.eth.Contract(spellSushiABI, sushiSpell);
    masterChef = await new web3.eth.Contract(masterChefABI, chef);

    await hre.network.provider.request(
        {
            method: "hardhat_impersonateAccount",
            params: [AHGov]
        }
    )

    dai = await MockERC20.at(tokens.dai.address);
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

  describe('set functions', function () {
  })

  describe('withdraw', function () {
  });

  describe('deposit', function () {
  });

  describe("harvest", function () {
    beforeEach(async function () {
        await setBalance('dai', daiAdaptor.address, '1000000');
    })

    it('Run fresh harvest on AHv2 strategy', async () => {
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
        await primaryStrategy.panicClose({from: governance});
        console.log(JSON.stringify(posData));
    })
  })

  describe("withdrawToAdapter", function () {
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

  describe("setStrategyDebtRatio", function () {
  })

  describe("Utility", function () {
  })
})
