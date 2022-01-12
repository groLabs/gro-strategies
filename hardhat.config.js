require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-web3");
require("hardhat-gas-reporter");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-contract-sizer");
require("hardhat-abi-exporter");
require("solidity-coverage");
require("dotenv").config();
require("hardhat-prettier");

const FORK_FUJI = false;
const FORK_MAINNET = true;
const forkingData = FORK_FUJI
    ? {
          url: "https://api.avax-test.network/ext/bc/C/rpc",
      }
    : FORK_MAINNET
    ? {
          url: "https://api.avax.network/ext/bc/C/rpc",
      }
    : undefined;

const fs = require("fs");
const Accounts = require("web3-eth-accounts");

const accounts = new Accounts("ws://localhost:8545");
let account, referal, bot, kovan, mainnet, ropsten, goerli;
if (process.env["DEPLOY_MAIN"] === "1") {
    let keystoreD = JSON.parse(fs.readFileSync("deployment"));
    let keyD = accounts.decrypt(keystoreD, process.env["PPASS"]);
    let keystoreB = JSON.parse(fs.readFileSync("harvest_bot"));
    let keyB = accounts.decrypt(keystoreB, process.env["BOT"]);
    account = keyD.privateKey;
    bot = keyB.privateKey;
    referal = process.env["REF"];
} else if (process.env["DEPLOY_MAIN"] === "2") {
    let keystoreD = JSON.parse(fs.readFileSync("deployment_avax"));
    let keyD = accounts.decrypt(keystoreD, process.env["AVAX"]);
    account = keyD.privateKey;
    bot = process.env["DEV_BOT"];
    referal = process.env["REF"];
} else {
    account = process.env["DEV"];
    bot = process.env["DEV_BOT"];
    referal = process.env["REF"];
}

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    networks: {
        hardhat: {
            gasPrice: 225000000000,
            chainId: 43112, //!forkingData ? 43112 : undefined, //Only specify a chainId if we are not forking
            forking: forkingData,
        },
        local: {
            url: "http://localhost:8545",
            gas: 12000000,
            blockGasLimit: 12000000,
            // url: 'http://localhost:9650/ext/bc/C/rpc',
            // gasPrice: 225000000000,
            // chainId: 43112,
        },
        fuji: {
            url: "https://api.avax-test.network/ext/bc/C/rpc",
            gasPrice: 225000000000,
            chainId: 43113,
            accounts: [],
        },
        mainnet: {
            url: "https://api.avax.network/ext/bc/C/rpc",
            gasPrice: 225000000000,
            chainId: 43114,
            accounts: [account],
        },
    },
    mocha: {
        useColors: true,
        // reporter: 'eth-gas-reporter',
        timeout: 6000000,
    },
    etherscan: {
        apiKey: "EIR8RN3REQHWQ8UW11Z9NBVMVA3H7GE56Z",
    },
    abiExporter: {
        path: "./data/abi",
        clear: true,
        flat: true,
        spacing: 2,
    },
    contractSizer: {
        alphaSort: true,
        runOnCompile: true,
        disambiguatePaths: false,
    },
    solidity: {
        compilers: [
            {
                version: "0.8.4",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
            {
                version: "0.6.11",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
};
