import pytest
import os
from brownie import web3
from pathlib import Path
import json

HOME = os.environ['HOME']
PATH = f'{HOME}/DAPPS/gro-strategies/contracts/mocks/abi'

def genContract(_address, _name):
    for path in Path(PATH).rglob(f'{_name}'):
        ABI = []
        ABI_CHECK = True
        with open(path, 'r') as f:
            data = json.load(f)
            if 'abi' in data:
                ABI = data['abi']
            else:
                ABI = data
    return web3.eth.contract(address=web3.toChecksumAddress(_address), abi=ABI)

@pytest.fixture(scope='function', autouse=True)
def avax():
    return genContract('0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', 'MockERC20.json')

@pytest.fixture(scope='function', autouse=True)
def usdc():
    return genContract('0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', 'MockERC20.json')

@pytest.fixture(scope='function', autouse=True)
def usdt():
    return genContract('0xc7198437980c041c805A1EDcbA50c1Ce5db95118', 'MockERC20.json')

@pytest.fixture(scope='function', autouse=True)
def dai():
    return genContract('0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', 'MockERC20.json')

@pytest.fixture(scope='function', autouse=True)
def joe():
    return genContract('0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', 'MockERC20.json')

@pytest.fixture(scope='function', autouse=True)
def homoraBank():
    return genContract('0x376d16C7dE138B01455a51dA79AD65806E9cd694', 'homora.json')
