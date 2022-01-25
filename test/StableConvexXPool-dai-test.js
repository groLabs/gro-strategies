const VaultAdaptor = artifacts.require("VaultAdaptorMK2");
const ConvexXPool = artifacts.require("StableConvexXPool");
const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20");

const {toBN} = require("web3-utils");
const {tokens} = require("./utils/common-utils");

const UNI_V3 = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SUSHI = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F";

const HUSD_PID = 11;
const HUSD_POOL = "0x3eF6A01A0f81D6046290f3e2A8c5b843e738E604";

contract("convex xpool tests", function (accounts) {
    const [deployer] = accounts;

    let dai, daiVault, daiStrategy;

    beforeEach(async function () {
        dai = await IERC20.at(tokens.dai.address);
        daiVault = await VaultAdaptor.new(tokens.dai.address);
        daiStrategy = await ConvexXPool.new(daiVault.address, 0);
        await daiStrategy.setKeeper(daiVault.address);

        const botLimit = toBN(0);
        const topLimit = toBN(2).pow(toBN(256)).sub(toBN(1));

        await daiVault.addStrategy(daiStrategy.address, 10000, botLimit, topLimit);

        await daiStrategy.setNewPool(HUSD_PID, HUSD_POOL);
        // await daiStrategy.switchDex(0, UNI_V3);
        // await daiStrategy.switchDex(1, SUSHI);
    });

    afterEach(async function () {});

    describe("dai", function () {
        it.only("deposit", async () => {});

        it("withdraw", async () => {});

        it("harvest", async () => {});

        it("harvestTrigger", async () => {});
    });
});
