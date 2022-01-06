import pytest
from brownie import web3, project

topLimit = 2 ** 256 - 1

def setup_adaptor(account, adaptor):
    adaptor.setDepositLimit(topLimit, {'from': account})
    adaptor.addToWhitelist(account, {'from': account})

@pytest.fixture(scope='function', autouse=True)
def dai_adaptor(a, dai, bouncer, VaultAdaptorMK2):
    adaptor = a[0].deploy(VaultAdaptorMK2, dai.address, 10000, bouncer);
    setup_adaptor(a[0], adaptor)
    return adaptor

@pytest.fixture(scope='function', autouse=True)
def usdc_adaptor(a, usdc, bouncer, VaultAdaptorMK2):
    adaptor = a[0].deploy(VaultAdaptorMK2, usdc.address, 10000, bouncer);
    setup_adaptor(a[0], adaptor)
    return adaptor

@pytest.fixture(scope='function', autouse=True)
def usdt_adaptor(a, usdt, bouncer, VaultAdaptorMK2):
    adaptor = a[0].deploy(VaultAdaptorMK2, usdt.address, 10000, bouncer);
    setup_adaptor(a[0], adaptor)
    return adaptor
