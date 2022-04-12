require("@nomiclabs/hardhat-truffle5");
require('@nomiclabs/hardhat-vyper')
require("@nomiclabs/hardhat-web3");
require("hardhat-gas-reporter");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-contract-sizer");
require("hardhat-abi-exporter");
require("solidity-coverage");
require("dotenv").config();
require("hardhat-prettier");

const fs = require("fs");
const Accounts = require('web3-eth-accounts');

const accounts = new Accounts('ws://localhost:8545');
let account, referal, bot, kovan, mainnet, ropsten, goerli;
if (process.env['DEPLOY_MAIN'] === '1') {
  let keystoreD = JSON.parse(fs.readFileSync("deployment"));
  let keyD = accounts.decrypt(keystoreD, process.env['PPASS']);
  let keystoreB = JSON.parse(fs.readFileSync("harvest_bot"));
  let keyB = accounts.decrypt(keystoreB, process.env['BOT']);
  account = keyD.privateKey
  bot = keyB.privateKey
  referal = process.env['REF']
} else if (process.env['DEPLOY_MAIN'] === '2') {
  let keystoreD = JSON.parse(fs.readFileSync("ahbot"));
  let keyD = accounts.decrypt(keystoreD, process.env['AHBOT']);
  account = keyD.privateKey
  bot = process.env['DEV_BOT']
  referal = process.env['REF']
}
else {
  account = process.env['DEV']
  bot = process.env['DEV_BOT']
  referal = process.env['REF']
}
mainnet = process.env['mainnet']
ropsten = process.env['ropsten']

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    networks: {
        localhost: {
            url: "http://localhost:8545",
            gas: 12000000,
            blockGasLimit: 12000000,
            initialBaseFeePerGas: 0,
        },
        hardhat: {
            forking: {
                url: mainnet,
            },
            gas: 12000000,
            blockGasLimit: 0x1fffffffffffff,
            allowUnlimitedContractSize: true,
            initialBaseFeePerGas: 0,
            timeout: 1800000,
        },
        ropsten: {
          url: ropsten,
          accounts: [
            account,
            referal
          ],
          chainId: 3,
          gas: 'auto',
          gasPrice: 'auto',
          timeout: 10000,
        }
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
                version: "0.8.3",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
            {
                version: "0.6.12",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200,
                    },
                },
            },
        ],
    },
    vyper: {
      version: '0.2.8',
    },
};
