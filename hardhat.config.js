require('@nomiclabs/hardhat-truffle5')
require('@nomiclabs/hardhat-web3')
require('hardhat-gas-reporter')
require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-etherscan')
require('hardhat-contract-sizer');
require('hardhat-abi-exporter');
require('dotenv').config();
require('hardhat-prettier');

kovan = process.env['kovan']
mainnet = process.env['mainnet']
ropsten = process.env['ropsten']
goerli = process.env['goerli']

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  networks: {
    localhost: {
      url: 'http://127.0.0.1:8545',
      gas: 12000000,
      blockGasLimit: 12000000
    },
    hardhat: {
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
    apiKey: "EIR8RN3REQHWQ8UW11Z9NBVMVA3H7GE56Z"
  },
  abiExporter: {
    path: './data/abi',
    clear: true,
    flat: true,
    spacing: 2
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
  solidity: {
    compilers: [
      {
        version: '0.6.12',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        }
      },
      {
        version: '0.8.3',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        }
      }
    ]
  }
}
