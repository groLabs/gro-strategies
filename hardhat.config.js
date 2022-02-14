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

mainnet = process.env["mainnet"];

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
    networks: {
        localhost: {
            url: "http://localhost:8545",
            gas: 12000000,
            blockGasLimit: 12000000,
        },
        hardhat: {
            forking: {
                url: mainnet,
            },
            gas: 12000000,
            blockGasLimit: 0x1fffffffffffff,
            allowUnlimitedContractSize: true,
            timeout: 1800000,
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
