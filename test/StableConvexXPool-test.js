const VaultAdaptor = artifacts.require("Vault");
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

const FRAX_PID = 32;
const FRAX_POOL = "0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B";

const UST_PID = 21;
const UST_POOL = "0x890f4e345B1dAED0367A877a1612f86A1f86985f";

const USDP_PID = 28;
const USDP_POOL = "0x42d7025938bEc20B69cBae5A77421082407f053A";

const CONVEX_BOOSTER = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31";
const CONVEX_FRAX_REWARD = "0xB900EF131301B307dB5eFcbed9DBb50A3e209B2e";
const CONVEX_UST_REWARD = "0xd4Be1911F8a0df178d6e7fF5cE39919c273E2B7B";
const CONVEX_USDP_REWARD = "0x24DfFd1949F888F91A0c8341Fc98a3F280a782a8";

const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";

contract("convex xpool tests", function (accounts) {
    const [deployer, investor1] = accounts;

    const botLimit = toBN(0);
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    let dai, daiVault, daiStrategy, usdc, usdcVault, usdcStrategy, usdt, usdtVault, usdtStrategy,
        mockController, mockInsurance, mockPnL, rewards, crv;

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
        sId = await snapshotChain();
        console.log("snaphsort id: " + sId);

        mockController = await MockController.new();
        mockInsurance = await MockInsurance.new();
        mockPnL = await MockPnL.new();
        await mockController.setInsurance(mockInsurance.address);
        await mockController.setPnL(mockPnL.address);

        rewards = await IRewards.at(CONVEX_USDP_REWARD);
        crv = await IERC20.at(CRV);
    });

    afterEach(async function () {
        if (sId) {
            await revertChain(sId);
            console.log("revert to " + sId);
        }
    });

    describe.skip("ad-hoc", function () {
        it("list pools", async () => {
            let booster = await Booster.at(CONVEX_BOOSTER);
            for (let i = 0; i < 68; i++) {
                let result = await booster.poolInfo(i);
                console.log(`pool${i} lptoken: ${result[0]}, token: ${result[1]}`);
                // console.log('result: ' + JSON.stringify(result));
            }
        })
    })

    describe("dai", function () {
        beforeEach(async function () {
            dai = await IERC20.at(tokens.dai.address);
            daiVault = await VaultAdaptor.new();
            await daiVault.initialize(dai.address, deployer, 'testVault', deployer);
            await daiVault.setDepositLimit(toBN(2).pow(toBN(256)).sub(toBN(1)));
            console.log(`daiVault ${daiVault.address} dai ${dai.address}`)
            console.log(`daiVault token ${await daiVault.token()} dai ${dai.address}`)
            daiStrategy = await ConvexXPool.new(daiVault.address, 0);
            await daiStrategy.setKeeper(daiVault.address);
            // await daiVault.setController(mockController.address);

            await daiVault.addStrategy(daiStrategy.address, 10000, botLimit, topLimit);
            await daiStrategy.setNewPool(USDP_PID, USDP_POOL);
            // await daiStrategy.switchDex(0, UNI_V3);
            // await daiStrategy.switchDex(1, SUSHI);
            await dai.approve(daiVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
        })

        it("deposit", async () => {
            const amount = "3000000";
            await setBalance("dai", investor1, amount);
            await daiVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e18)), {from: investor1});
        });

        it("harvest & harvestTrigger when have profit", async () => {
            const amount = "20000000";
            await setBalance("dai", investor1, amount);
            await daiVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e18)), {from: investor1});

            await daiStrategy.harvest();

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(50);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
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

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));


            await daiStrategy.harvest();


            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            let result = await daiVault.strategies(daiStrategy.address);
            console.log('daiStrategy totalDebt: ' + result.totalDebt);
            console.log('daiVault totalAssets: ' + await daiVault.totalAssets());
        });

        it("harvest & harvestTrigger when switch pool and have profit", async () => {
            const amount = "20000000";
            await setBalance("dai", investor1, amount);
            await daiVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e18)), {from: investor1});

            await daiStrategy.harvest();

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(500);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            await daiStrategy.setNewPool(21, UST_POOL);


            await daiStrategy.harvest();


            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            let result = await daiVault.strategies(daiStrategy.address);
            console.log('daiStrategy totalDebt: ' + result.totalDebt);
            console.log('daiVault totalAssets: ' + await daiVault.totalAssets());

            console.log('daiStrategy curve: ' + await daiStrategy.curve());
            console.log('daiStrategy lpToken: ' + await daiStrategy.lpToken());
            console.log('daiStrategy pId: ' + await daiStrategy.pId());
            console.log('daiStrategy rewardContract: ' + await daiStrategy.rewardContract());
        });

        it("harvest & harvestTrigger when switch pool and have loss", async () => {
            const amount = "20000000";
            await setBalance("dai", investor1, amount);
            await daiVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e18)), {from: investor1});

            await daiStrategy.harvest();

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            await daiStrategy.setNewPool(21, UST_POOL);


            await daiStrategy.harvest();


            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            let result = await daiVault.strategies(daiStrategy.address);
            console.log('daiStrategy totalDebt: ' + result.totalDebt);
            console.log('daiVault totalAssets: ' + await daiVault.totalAssets());

            console.log('daiStrategy curve: ' + await daiStrategy.curve());
            console.log('daiStrategy lpToken: ' + await daiStrategy.lpToken());
            console.log('daiStrategy pId: ' + await daiStrategy.pId());
            console.log('daiStrategy rewardContract: ' + await daiStrategy.rewardContract());
        });

        it("withdraw", async () => {
            const amount = "20000000";
            await setBalance("dai", investor1, amount);
            await daiVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e18)), {from: investor1});

            await daiStrategy.harvest();

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            console.log('daiStrategy.harvestTrigger: ' + await daiStrategy.harvestTrigger(0));

            await daiVault.withdraw(toBN(amount).div(toBN(10)).mul(toBN(1e18)), investor1);
            console.log("investor1 amount: " + (await dai.balanceOf(investor1)));

            console.log('daiStrategy.estimatedTotalAssets: ' + await daiStrategy.estimatedTotalAssets());
            let result = await daiVault.strategies(daiStrategy.address);
            console.log('daiStrategy totalDebt: ' + result.totalDebt);
            console.log('daiVault totalAssets: ' + await daiVault.totalAssets());
        });
    });

    describe("usdc", function () {
        beforeEach(async function () {
            usdc = await IERC20.at(tokens.usdc.address);
            usdcVault = await VaultAdaptor.new();
            await usdcVault.initialize(usdc.address, deployer, 'testVault', deployer);
            await usdcVault.setDepositLimit(toBN(2).pow(toBN(256)).sub(toBN(1)));
            usdcStrategy = await ConvexXPool.new(usdcVault.address, 1);
            await usdcStrategy.setKeeper(usdcVault.address);

            // await usdcVault.setController(mockController.address);
            await usdcVault.addStrategy(usdcStrategy.address, 10000, botLimit, topLimit);
            await usdcStrategy.setNewPool(USDP_PID, USDP_POOL);
            await usdc.approve(usdcVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
        })

        it("deposit", async () => {
            const amount = "3000000";
            await setBalance("usdc", investor1, amount);
            await usdcVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});
        });

        it("harvest & harvestTrigger when have profit", async () => {
            const amount = "20000000";
            await setBalance("usdc", investor1, amount);
            await usdcVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdcStrategy.harvest();

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(50);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));


            await usdcStrategy.harvest();


            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            let result = await usdcVault.strategies(usdcStrategy.address);
            console.log('usdcStrategy totalDebt: ' + result.totalDebt);
            console.log('usdcVault totalAssets: ' + await usdcVault.totalAssets());
        });

        it("harvest & harvestTrigger when switch pool and have profit", async () => {
            const amount = "20000000";
            await setBalance("usdc", investor1, amount);
            await usdcVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdcStrategy.harvest();

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(500);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));

            await usdcStrategy.setNewPool(21, UST_POOL);


            await usdcStrategy.harvest();


            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            let result = await usdcVault.strategies(usdcStrategy.address);
            console.log('usdcStrategy totalDebt: ' + result.totalDebt);
            console.log('usdcVault totalAssets: ' + await usdcVault.totalAssets());

            console.log('usdcStrategy curve: ' + await usdcStrategy.curve());
            console.log('usdcStrategy lpToken: ' + await usdcStrategy.lpToken());
            console.log('usdcStrategy pId: ' + await usdcStrategy.pId());
            console.log('usdcStrategy rewardContract: ' + await usdcStrategy.rewardContract());
        });

        it("harvest & harvestTrigger when switch pool and have loss", async () => {
            const amount = "20000000";
            await setBalance("usdc", investor1, amount);
            await usdcVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdcStrategy.harvest();

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));

            await usdcStrategy.setNewPool(21, UST_POOL);


            await usdcStrategy.harvest();


            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            let result = await usdcVault.strategies(usdcStrategy.address);
            console.log('usdcStrategy totalDebt: ' + result.totalDebt);
            console.log('usdcVault totalAssets: ' + await usdcVault.totalAssets());

            console.log('usdcStrategy curve: ' + await usdcStrategy.curve());
            console.log('usdcStrategy lpToken: ' + await usdcStrategy.lpToken());
            console.log('usdcStrategy pId: ' + await usdcStrategy.pId());
            console.log('usdcStrategy rewardContract: ' + await usdcStrategy.rewardContract());
        });

        it("withdraw", async () => {
            const amount = "20000000";
            await setBalance("usdc", investor1, amount);
            await usdcVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdcStrategy.harvest();

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            console.log('usdcStrategy.harvestTrigger: ' + await usdcStrategy.harvestTrigger(0));

            await usdcVault.withdraw(toBN(amount).div(toBN(10)).mul(toBN(1e6)), investor1);
            console.log("investor1 amount: " + (await usdc.balanceOf(investor1)));

            console.log('usdcStrategy.estimatedTotalAssets: ' + await usdcStrategy.estimatedTotalAssets());
            let result = await usdcVault.strategies(usdcStrategy.address);
            console.log('usdcStrategy totalDebt: ' + result.totalDebt);
            console.log('usdcVault totalAssets: ' + await usdcVault.totalAssets());
        });
    });

    describe("usdt", function () {
        beforeEach(async function () {
            usdt = await IERC20.at(tokens.usdt.address);
            usdtVault = await VaultAdaptor.new();
            await usdtVault.initialize(usdt.address, deployer, 'testVault', deployer);
            await usdtVault.setDepositLimit(toBN(2).pow(toBN(256)).sub(toBN(1)));
            usdtStrategy = await ConvexXPool.new(usdtVault.address, 2);
            await usdtStrategy.setKeeper(usdtVault.address);

            // await usdtVault.setController(mockController.address);
            await usdtVault.addStrategy(usdtStrategy.address, 10000, botLimit, topLimit);
            await usdtStrategy.setNewPool(USDP_PID, USDP_POOL);
            await usdt.approve(usdtVault.address, 0, {from: investor1});
            await usdt.approve(usdtVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
        })

        it("deposit", async () => {
            const amount = "3000000";
            await setBalance("usdt", investor1, amount);
            await usdtVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});
        });

        it("harvest & harvestTrigger when have profit", async () => {
            const amount = "20000000";
            await setBalance("usdt", investor1, amount);
            await usdtVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdtStrategy.harvest();

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(50);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));


            await usdtStrategy.harvest();


            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            let result = await usdtVault.strategies(usdtStrategy.address);
            console.log('usdtStrategy totalDebt: ' + result.totalDebt);
            console.log('usdtVault totalAssets: ' + await usdtVault.totalAssets());
        });

        it("harvest & harvestTrigger when switch pool and have profit", async () => {
            const amount = "20000000";
            await setBalance("usdt", investor1, amount);
            await usdtVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdtStrategy.harvest();

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));

            let rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let multiple = toBN(500);
            const value = web3.utils.padLeft(toHex(rewardRate.mul(multiple)), 64);
            await hre.ethers.provider.send("hardhat_setStorageAt", [rewards.address, "0x6", value]);

            rewardRate = await rewards.rewardRate();
            console.log('rewards.rewardRate: ' + rewardRate);

            let periodFinish = await rewards.periodFinish();
            console.log('rewards.periodFinish: ' + periodFinish);
            await network.provider.request({
                method: "evm_setNextBlockTimestamp",
                params: [periodFinish-100],
            });
            await network.provider.send("evm_mine");

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());

            let crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);
            crvAmount = crvAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
            await setBalance("crv", rewards.address, crvAmount.toString(), 1);
            crvAmount = await crv.balanceOf(rewards.address);
            console.log('rewards.CRV: ' + crvAmount);

            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));

            await usdtStrategy.setNewPool(21, UST_POOL);


            await usdtStrategy.harvest();


            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            let result = await usdtVault.strategies(usdtStrategy.address);
            console.log('usdtStrategy totalDebt: ' + result.totalDebt);
            console.log('usdtVault totalAssets: ' + await usdtVault.totalAssets());

            console.log('usdtStrategy curve: ' + await usdtStrategy.curve());
            console.log('usdtStrategy lpToken: ' + await usdtStrategy.lpToken());
            console.log('usdtStrategy pId: ' + await usdtStrategy.pId());
            console.log('usdtStrategy rewardContract: ' + await usdtStrategy.rewardContract());
        });

        it("harvest & harvestTrigger when switch pool and have loss", async () => {
            const amount = "20000000";
            await setBalance("usdt", investor1, amount);
            await usdtVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdtStrategy.harvest();

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));

            await usdtStrategy.setNewPool(21, UST_POOL);


            await usdtStrategy.harvest();


            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            let result = await usdtVault.strategies(usdtStrategy.address);
            console.log('usdtStrategy totalDebt: ' + result.totalDebt);
            console.log('usdtVault totalAssets: ' + await usdtVault.totalAssets());

            console.log('usdtStrategy curve: ' + await usdtStrategy.curve());
            console.log('usdtStrategy lpToken: ' + await usdtStrategy.lpToken());
            console.log('usdtStrategy pId: ' + await usdtStrategy.pId());
            console.log('usdtStrategy rewardContract: ' + await usdtStrategy.rewardContract());
        });

        it("withdraw", async () => {
            const amount = "20000000";
            await setBalance("usdt", investor1, amount);
            await usdtVault.methods['deposit(uint256)'](toBN(amount).mul(toBN(1e6)), {from: investor1});

            await usdtStrategy.harvest();

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            console.log('usdtStrategy.harvestTrigger: ' + await usdtStrategy.harvestTrigger(0));

            await usdtVault.withdraw(toBN(amount).div(toBN(10)).mul(toBN(1e6)), investor1, 100);
            console.log("investor1 amount: " + (await usdt.balanceOf(investor1)));

            console.log('usdtStrategy.estimatedTotalAssets: ' + await usdtStrategy.estimatedTotalAssets());
            let result = await usdtVault.strategies(usdtStrategy.address);
            console.log('usdtStrategy totalDebt: ' + result.totalDebt);
            console.log('usdtVault totalAssets: ' + await usdtVault.totalAssets());
        });
    })
});
