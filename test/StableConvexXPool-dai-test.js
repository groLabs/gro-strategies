const VaultAdaptor = artifacts.require("VaultAdaptorMK2");
const ConvexXPool = artifacts.require("StableConvexXPool");
const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20");
const MockController = artifacts.require("MockController");
const MockInsurance = artifacts.require("MockInsurance");
const MockPnL = artifacts.require("MockPnL");
const Booster = artifacts.require("contracts/strategies/StableConvexXPool.sol:Booster");
const IRewards = artifacts.require("IRewards");

const {toBN, toHex} = require("web3-utils");
const {tokens, setBalance} = require("./utils/common-utils");
const { constants } = require('./utils/constants');

const UNISWAP = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const DUSD_PID = 17;
const DUSD_POOL = "0x8038C01A0390a8c547446a0b2c18fc9aEFEcc10c";

const CONVEX_BOOSTER = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31";
const CONVEX_DUSD_REWARD = "0x1992b82A8cCFC8f89785129D6403b13925d6226E";

const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";
const CRV_HODLER = "";

contract("convex xpool tests", function (accounts) {
    const [deployer, investor1] = accounts;

    let dai, daiVault, daiStrategy, dusdRewards, crv;

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

    beforeEach(async function () {
        let mockController = await MockController.new();
        let mockInsurance = await MockInsurance.new();
        let mockPnL = await MockPnL.new();
        await mockController.setInsurance(mockInsurance.address);
        await mockController.setPnL(mockPnL.address);

        dai = await IERC20.at(tokens.dai.address);
        daiVault = await VaultAdaptor.new(tokens.dai.address);
        daiStrategy = await ConvexXPool.new(daiVault.address, 0);
        await daiStrategy.setKeeper(daiVault.address);

        await daiVault.setController(mockController.address);

        const botLimit = toBN(0);
        const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

        await daiVault.addStrategy(daiStrategy.address, 10000, botLimit, topLimit);

        await daiStrategy.setNewPool(DUSD_PID, DUSD_POOL);
        // await daiStrategy.switchDex(0, UNI_V3);
        // await daiStrategy.switchDex(1, SUSHI);

        await dai.approve(daiVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});

        dusdRewards = await IRewards.at(CONVEX_DUSD_REWARD);
        crv = await IERC20.at(CRV);

        // await hre.network.provider.request({
        //     method: "hardhat_impersonateAccount",
        //     params: [CRV_HODLER],
        // });

        // let ethAmount = toBN("1000000000000000000000");
        // await hre.network.provider.send("hardhat_setBalance", [CRV_HODLER, toHex(ethAmount)]);

        sId = await snapshotChain();
        console.log("snaphsort id: " + sId);
    });

    afterEach(async function () {
        if (sId) {
            await revertChain(sId);
            console.log("revert to " + sId);
        }
    });

    describe("dai", function () {

        it.skip("list pools", async () => {
            let booster = await Booster.at(CONVEX_BOOSTER);
            for (let i = 0; i < 68; i++) {
                let result = await booster.poolInfo(i);
                console.log(`pool${i} lptoken: ${result[0]}, token: ${result[1]}`);
                // console.log('result: ' + JSON.stringify(result));
            }
        })

        it("deposit", async () => {
            const amount = "3000000";
            await setBalance("dai", investor1, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});
        });

        it("withdraw", async () => {
            const amount = "3000000";
            await setBalance("dai", investor1, amount);
            console.log("amount0: " + (await dai.balanceOf(investor1)));
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});
            console.log("amount1: " + (await dai.balanceOf(investor1)));

            await daiVault.withdraw(toBN(amount).mul(toBN(1e18)), investor1);
            console.log("amount2: " + (await dai.balanceOf(investor1)));
        });

        it.only("harvest & harvestTrigger", async () => {
            const amount = "20000000";
            await setBalance("dai", investor1, amount);
            await daiVault.deposit(toBN(amount).mul(toBN(1e18)), {from: investor1});

            await daiStrategy.harvest();

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            let rewardRate = await dusdRewards.rewardRate();
            console.log('dusdRewards.rewardRate: ' + rewardRate);

            let multiple = toBN(100);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [dusdRewards.address, "0x6", value]);

            rewardRate = await dusdRewards.rewardRate();
            console.log('dusdRewards.rewardRate: ' + rewardRate);

            let periodFinish = await dusdRewards.periodFinish();
            console.log('dusdRewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            // let blocks = 1000;
            // console.log(`start to move ${blocks} blocks`)
            // for (let i = 0; i < blocks; i++) {
            //     await network.provider.send("evm_mine");
            // }
            // console.log(`end to move ${blocks} blocks`)

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(dusdRewards.address);
            console.log('dusdRewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", dusdRewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(dusdRewards.address);
            console.log('dusdRewards.CRV: ' + crvAmount);

            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));


            await daiStrategy.harvest();


            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            let result = await daiVault.strategies(daiStrategy.address);
            console.log('daiStrategy totalDebt: ' + result.totalDebt);
            console.log('daiVault totalAssets: ' + await daiVault.totalAssets());
        });

        it("harvestTrigger", async () => {});
    });
});
