import pytest
from brownie import web3

def setUpBank(account, bank, token):
    web3.eth.send_transaction({'from':account.address, 'to':bank, 'value': 1000000000000000000})
    bank_balance = token.functions.balanceOf(bank).call()
    token.functions.transfer(account.address, bank_balance).transact({'from': bank})

@pytest.fixture(scope='function')
def admin(a):
    return a[0]

@pytest.fixture(scope='function')
def investor1(a):
    return a[1]

@pytest.fixture(scope='function')
def investor2(a):
    return a[2]

@pytest.fixture(scope='function')
def bouncer(a):
    return a[3]

@pytest.fixture(scope='function')
def AHGov(a):
    AHGov = web3.toChecksumAddress('0xc05195e2EE3e4Bb49fA989EAA39B88A5001d52BD')
    web3.eth.send_transaction({'from': a[0].address, 'to': AHGov, 'value': 1000000000000000000})
    return AHGov

@pytest.fixture(scope='function')
def usdtBank(a, usdt):
    tbank = web3.toChecksumAddress('0x2D6B7235DB3659C1751f342F6C80A49727bb1a1D')
    setUpBank(a[1], tbank, usdt)
    return tbank;

@pytest.fixture(scope='function')
def usdcBank(a, usdc):
    cbank = web3.toChecksumAddress('0x1af3088078b5b887179925b8c5eb7b381697fec6')
    setUpBank(a[1], cbank, usdc)
    return cbank

@pytest.fixture(scope='function')
def daiBank(a, dai):
    dbank = web3.toChecksumAddress('0x20243F4081b0F777166F656871b61c2792FB4124')
    setUpBank(a[1], dbank, dai)
    return daiBank
