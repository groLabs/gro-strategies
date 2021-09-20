# gro-strategies
Strategies for gro-protocol

[Project overview](https://docs.google.com/spreadsheets/d/1hXfzm3FTHXznesnYs-yb2gjZjfrQQKcn_lAkGmb2T_4/edit?usp=sharing)

## Prepare local environment

1. install `nodejs`, refer to [nodejs](https://nodejs.org/en/)
2. install `yarn`, refer to [yarn](https://classic.yarnpkg.com/en/)
3. setup the .env file in the root directory of the project:
    needs a rpc node reference called main, e.g. 'mainnet=https://eth-mainnet.alchemyapi.io/v2/<KEY>'

## Test

Test need to be run against a fork of mainnet to work correctly, as the interact with external contracts.
1. run `yarn install` in workspace root folder
2. run `npx hardhat test` command in terminal

## Hardhat command

1. npx hardhat compile: compile the contracts
2. npx hardhat test: run the test cases under test folder

more information can refer to [hardhat](https://hardhat.org/getting-started/#quick-start)

## Running on forked chain
All tests are expected to pass on a mainnet fork.

Example of hardhat.config setup of forked mainnet using alchemy node
```
hardhat: {
  forking: { url: "--fork https://eth-mainnet.alchemyapi.io/v2/<KEY>"  },
  gas: 12000000,
  blockGasLimit: 0x1fffffffffffff,
  allowUnlimitedContractSize: true,                   
  timeout: 1800000,
          
},                          
```

## Running on local fork
Unless a forking variable is specified in the hardhat config (requires node access to be run), the system
will deploy on a harhat fork, but a separate one can be started using hardhat.
Some test (smoke test with the word mainnet in the title) aren't supposed to complete on a local branch,
as they depend on interactions with external contracts.

Example of hardhat.config setup of locally deployed chain (hardhat node)

```
localhost: {
  url: 'http://127.0.0.1:8545',
  gas: 12000000,
  blockGasLimit: 12000000
      
},                        
```

starting hardhat node:
```
npx hardhat node --fork https://eth-mainnet.alchemyapi.io/v2/<KEY>
```


## Dependencies

Hardhat v2.6.1

Solidity - 0.6.11, 0.8.3 (solc-js)

Node v14.0.0+


Web3.js v1.5.1+

yarn 1.22.10
