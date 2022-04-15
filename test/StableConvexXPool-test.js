const VaultAdaptor = artifacts.require("Vault");
const ConvexXPool = artifacts.require("StableConvexXPool");
const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20");
const IERC20Detailed = artifacts.require("contracts/interfaces/IERC20Detailed.sol:IERC20Detailed");
const MockController = artifacts.require("MockController");
const MockInsurance = artifacts.require("MockInsurance");
const MockPnL = artifacts.require("MockPnL");
const Booster = artifacts.require("contracts/strategies/StableConvexXPool.sol:Booster");
const IRewards = artifacts.require("IRewards");
const IVRewards = artifacts.require("IVRewards");

const {toBN, toHex} = require("web3-utils");
const {tokens, setBalance} = require("./utils/common-utils");
const { constants } = require('./utils/constants');

const UNISWAP = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const SUSHI = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const OUSD_PID = 56;
const OUSD_POOL = "0x87650D7bbfC3A9F10587d7778206671719d9910D";

const FRAX_PID = 32;
const FRAX_POOL = "0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B";

const MUSD_PID = 14;
const MUSD_POOL = "0x8474DdbE98F5aA3179B3B3F5942D724aFcdec9f6";

const UST_POOL = "0x890f4e345B1dAED0367A877a1612f86A1f86985f";

const CONVEX_BOOSTER = "0xF403C135812408BFbE8713b5A23a04b3D48AAE31";
const CONVEX_FRAX_REWARD = "0xB900EF131301B307dB5eFcbed9DBb50A3e209B2e";
const CONVEX_OUSD_REWARD = "0x7D536a737C13561e0D2Decf1152a653B4e615158";
const CONVEX_MUSD_REWARD = "0xDBFa6187C79f4fE4Cda20609E75760C5AaE88e52";

const CRV = "0xD533a949740bb3306d119CC777fa900bA034cd52";

contract("convex xpool tests", function (accounts) {
    const [deployer, investor1] = accounts;

    const botLimit = toBN(0);
    const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

    let dai, daiVault, daiStrategy, usdc, usdcVault, usdcStrategy, usdt, usdtVault, usdtStrategy,
        mockController, mockInsurance, mockPnL, rewards, vRewardsLength, vRewards, crv;

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
            await daiStrategy.setSlippage(100);
            // await daiVault.setController(mockController.address);

            await daiVault.addStrategy(daiStrategy.address, 10000, botLimit, topLimit);
            await daiStrategy.setNewPool(MUSD_PID, MUSD_POOL);
            // await daiStrategy.switchDex(0, UNI_V3);
            // await daiStrategy.switchDex(1, SUSHI);
            await dai.approve(daiVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
            rewards = await IRewards.at(CONVEX_MUSD_REWARD);
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
            await usdcStrategy.setSlippage(100);

            // await usdcVault.setController(mockController.address);
            await usdcVault.addStrategy(usdcStrategy.address, 10000, botLimit, topLimit);
            await usdcStrategy.setNewPool(OUSD_PID, OUSD_POOL);
            await usdc.approve(usdcVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
            rewards = await IRewards.at(CONVEX_OUSD_REWARD);
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
            await usdtStrategy.setSlippage(100);

            // await usdtVault.setController(mockController.address);
            await usdtVault.addStrategy(usdtStrategy.address, 10000, botLimit, topLimit);


            let noOfreward = await usdtStrategy.noOfRewards();
            console.log("before adding rewardToken: ", noOfreward);
            // await usdtStrategy to add rewardToken
            await usdtStrategy.addNewRewardedTokens("0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0", 0);

            noOfreward = await usdtStrategy.noOfRewards();
            console.log("after adding rewardToken: ", noOfreward);
            
            let newRewardToken = await usdtStrategy.rewardedTokens(0);
            console.log("before changing dex from 0 to 1: ", newRewardToken);
            // await usdtStrategy to change dex
            await usdtStrategy.setDexForRewardedToken("0x3432b6a60d23ca0dfca7761b7ab56459d9c964d0", 1, 0);

            newRewardToken = await usdtStrategy.rewardedTokens(0);
            console.log("after changing dex from 0 to 1: ", newRewardToken);

            await usdtStrategy.setNewPool(FRAX_PID, FRAX_POOL);
            await usdt.approve(usdtVault.address, 0, {from: investor1});
            await usdt.approve(usdtVault.address, toBN(2).pow(toBN(256)).sub(toBN(1)), {from: investor1});
            rewards = await IRewards.at(CONVEX_FRAX_REWARD);

            // testing harvest additional reward token wtih FRAX pool - FXS
            vRewardsLength = await rewards.extraRewardsLength();
            vRewards = [];
            for(let i=0; i<vRewardsLength;i++) {
                vRewardsAddress = await rewards.extraRewards(i);
                vReward = await IVRewards.at(vRewardsAddress);
                vRewards.push(vReward);
            }
            
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

            for (let vReward of vRewards) {
                let vRewardRate = await vReward.rewardRate();
                console.log('vRewards.rewardRate: ' + vRewardRate);
            }

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

            for (let vReward of vRewards) {
                let vRewardTokenAddress = await vReward.rewardToken();
                let vRewardToken = await IERC20.at(vRewardTokenAddress);
                let vRewardAmount = await vRewardToken.balanceOf(vReward.address);
                let vRewardTokenDetailed = await IERC20Detailed.at(vRewardTokenAddress);
                let vRewardSymbol = await vRewardTokenDetailed.symbol();
                console.log('rewards.' + vRewardSymbol + ' ' + vRewardAmount);

                vRewardAmount = vRewardAmount.mul(multiple).mul(toBN(2)).div(constants.DEFAULT_FACTOR);
                // assume FXS - use solidity, but for other tokens need to verify 
                await setBalance(vRewardSymbol, vReward.address, vRewardAmount.toString(), 0);
                vRewardAmount = await vRewardToken.balanceOf(vReward.address);
                console.log('rewards.' + vRewardSymbol + ' ' + vRewardAmount);
            }

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
