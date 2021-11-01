require('@nomiclabs/hardhat-truffle5')
require('@nomiclabs/hardhat-web3')
require('hardhat-gas-reporter')
require('@nomiclabs/hardhat-ethers')
require('@nomiclabs/hardhat-etherscan')
require('hardhat-contract-sizer');
require('hardhat-abi-exporter');
require("solidity-coverage");
require('dotenv').config();
require('hardhat-prettier');

mainnet = process.env['mainnet']
const FORK_FUJI = false
const FORK_MAINNET = true
const forkingData = FORK_FUJI ? {
      url: 'https://api.avax-test.network/ext/bc/C/rpc',

} : FORK_MAINNET ? {
      url: 'https://api.avax.network/ext/bc/C/rpc'

} : undefined

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  networks: {
    hardhat: {
      gasPrice: 225000000000,
      chainId: 43112, //!forkingData ? 43112 : undefined, //Only specify a chainId if we are not forking
      forking: forkingData
    },
    local: {
      url: 'http://127.0.0.1:8545',
      gas: 12000000,
      blockGasLimit: 12000000
      // url: 'http://localhost:9650/ext/bc/C/rpc',
      // gasPrice: 225000000000,
      // chainId: 43112,
    },
    fuji: {
      url: 'https://api.avax-test.network/ext/bc/C/rpc',
      gasPrice: 225000000000,
      chainId: 43113,
      accounts: []
    },
    mainnet: {
      url: 'https://api.avax.network/ext/bc/C/rpc',
      gasPrice: 225000000000,
      chainId: 43114,
      accounts: []
    }
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
        version: '0.8.4',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        }
      },
      {
        version: '0.6.11',
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
