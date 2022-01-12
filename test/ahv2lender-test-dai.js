const TestStrategy = artifacts.require("TestStrategy");
const LenderStrategy = artifacts.require("AHLender");
const VaultAdaptor = artifacts.require("VaultAdaptorMK2");
const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20");
const ICToken = artifacts.require("ICToken");
const {toBN, toWei, toHex} = require("web3-utils");
const {tokens, setBalance} = require("./utils/common-utils");
const {constants} = require("./utils/constants");
const fs = require("fs");

const DAI_SAFE_BOX = "0x69491FD9a6D9e32f32113cC076B1B69D8B9EBD3F";
const ROUNTER = "0x60aE616a2155Ee3d9A68541Ba4544862310933d4";
const AHGov = "0xc05195e2EE3e4Bb49fA989EAA39B88A5001d52BD";
const PROXY_HOMORA = "0x376d16C7dE138B01455a51dA79AD65806E9cd694";

const HOMORA_ABI = JSON.parse(fs.readFileSync("contracts/mocks/abi/homora.json"));

const BASE_ALLOWANCE = toBN(1e5).mul(toBN(1e18));
const ALLOWANCE = toBN(1e9).mul(toBN(1e18));

const BORROW_RATE = toBN(7000);

contract("ahv2 lender dai tests", function (accounts) {
    const [deployer, bouncer, investor1, investor2, investor3, investor4, investor5] = accounts;

    let dai, daiVault, primaryStrategy, secondaryStrategy, homoraBank;

    let sId;

    async function snapshotChain() {
        return await network.provider.request({
            method: "evm_snapshot",
            params: [],
        });
    }

    async function revertChain(snapshotId) {
        await network.provider.request({
            method: "evm_revert",
            params: [snapshotId],
        });
    }

    async function generateCTokenProfit() {
        const crDaiAddr = await primaryStrategy.crToken();
        const crDai = await ICToken.at(crDaiAddr);

        await dai.approve(crDai.address, constants.MAX_UINT256, {from: investor1});
        await dai.approve(crDai.address, constants.MAX_UINT256, {from: investor2});
        await dai.approve(crDai.address, constants.MAX_UINT256, {from: investor3});
        await dai.approve(crDai.address, constants.MAX_UINT256, {from: investor4});
        await dai.approve(crDai.address, constants.MAX_UINT256, {from: investor5});

        const investors = [investor1, investor2, investor3, investor4, investor5];
        const length = 5;
        const blockNumber = 100;

        console.log("start rate: " + (await crDai.exchangeRateStored()));

        for (let i = 0; i < length; i++) {
            let index = Math.floor(Math.random() * investors.length);
            let investor = investors[index];

            let cash = await crDai.getCash();
            // console.log("cash: " + cash);

            let amount = cash.div(toBN(10)).div(constants.DEFAULT_FACTOR).mul(constants.DEFAULT_FACTOR);
            await setBalance("dai", investor, amount.div(constants.DEFAULT_FACTOR).toString());

            // console.log("mint amount: " + amount);
            await crDai.mint(amount, {from: investor});
            amount = amount.mul(BORROW_RATE).div(constants.PERCENT_FACTOR);
            // console.log("amount: " + amount);
            await crDai.borrow(amount, {from: investor});

            for (let j = 0; j < blockNumber; j++) {
                await network.provider.send("evm_mine");
            }

            console.log(`${i} rate for ${index} investor: ` + (await crDai.exchangeRateStored()));
        }
    }

    beforeEach(async function () {
        // Impersonate AH governance so that we an add this strategy to the whitelist
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [AHGov],
        });
        await network.provider.send("hardhat_setBalance", [AHGov, toHex(toWei("10", "ether"))]);

        homoraBank = await new web3.eth.Contract(HOMORA_ABI, PROXY_HOMORA);

        dai = await IERC20.at(tokens.dai.address);
        avax = await IERC20.at(tokens.avax.address);

        daiVault = await VaultAdaptor.new(tokens.dai.address, BASE_ALLOWANCE, bouncer);

        primaryStrategy = await LenderStrategy.new(daiVault.address, DAI_SAFE_BOX, ROUNTER);
        await primaryStrategy.setKeeper(daiVault.address);
        const botLimit = toBN(0);
        const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

        await daiVault.addStrategy(primaryStrategy.address, 10000, botLimit, topLimit);

        // add a secondary dummy strategy, potentially not necessary but we have done
        // all modelling with the assumption that we have 2 strategies per vault min.
        secondaryStrategy = await TestStrategy.new(daiVault.address);
        await secondaryStrategy.setKeeper(daiVault.address);
        await daiVault.addStrategy(secondaryStrategy.address, 0, botLimit, topLimit);

        // add strategy to whitelist in homorabank and gov to whitelist in adapter so they can call harvest
        await homoraBank.methods.setWhitelistUsers([primaryStrategy.address], [true]).send({from: AHGov});
        await homoraBank.methods
            .setCreditLimits([[primaryStrategy.address, avax.address, toBN(1e18).mul(toBN(1e18)).toString()]])
            .send({from: AHGov});
        await daiVault.addToWhitelist(deployer);

        await daiVault.setDepositLimit(constants.MAX_UINT256);
        await dai.approve(daiVault.address, constants.MAX_UINT256, {from: investor1});
        await daiVault.setUserAllowance(investor1, ALLOWANCE, {from: bouncer});
        await dai.approve(daiVault.address, constants.MAX_UINT256, {from: investor2});
        await daiVault.setUserAllowance(investor2, ALLOWANCE, {from: bouncer});
        await dai.approve(daiVault.address, constants.MAX_UINT256, {from: investor3});
        await daiVault.setUserAllowance(investor3, ALLOWANCE, {from: bouncer});

        for (let i = 0; i < 10; i++) {
            await network.provider.send("evm_mine");
        }

        sId = await snapshotChain();
        console.log("snaphsort id: " + sId);
    });

    afterEach(async function () {
        if (sId) {
            await revertChain(sId);
            console.log("revert to " + sId);
        }
    });

    describe("dai strategy", function () {
        it("deposit", async () => {
            const amount = "3000000";
            await setBalance("dai", investor1, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});
        });

        it("withdraw", async () => {
            let amount = "3000000";
            await setBalance("dai", investor1, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});

            for (let i = 0; i < 30; i++) {
                await network.provider.send("evm_mine");
            }

            amount = await daiVault.balanceOf(investor1);
            console.log("vault amount: " + amount);
            await daiVault.withdraw(amount, 10, {from: investor1});
            amount = await dai.balanceOf(investor1);
            console.log("dai amount: " + amount);
        });

        it.only("harvest", async () => {
            let amount = "300000";
            await setBalance("dai", investor1, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});
            amount = "400000";
            await setBalance("dai", investor2, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor2});
            amount = "500000";
            await setBalance("dai", investor3, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor3});

            await daiVault.strategyHarvest(0);

            console.log("total assets: " + (await daiVault.totalAssets()));
            const sb = await IERC20.at(DAI_SAFE_BOX);
            console.log("strategy safebox balance: " + (await sb.balanceOf(primaryStrategy.address)));

            await generateCTokenProfit();

            console.log("total estimated assets: " + (await daiVault.totalEstimatedAssets()));
        });
    });
});
