import pytest
from brownie import web3, project

sushi_spell =  '0xdbc2aa11aa01baa22892de745c661db9f204b2cd'
router = '0x60aE616a2155Ee3d9A68541Ba4544862310933d4'

usdc_id = 39
usdt_id = 28
dai_id = 37

pool_dai = '0x87Dee1cC9FFd464B79e058ba20387c1984aed86a'
pool_usdc = '0xA389f9430876455C36478DeEa9769B7Ca4E3DDB1'
pool_usdt = '0xeD8CBD9F0cE3C6986b22002F03c6475CEb7a6256'

ZERO = '0x0000000000000000000000000000000000000000'

borrowLimit = int(1E7 * 1E18)
botLimit = 0
topLimit = 2 ** 256 - 1

def setup_strategy(a, strat, adaptor):
    strat.setBorrowLimit(borrowLimit);
    adaptor.addStrategy(strat.address, 10000, botLimit, topLimit)
    strat.setMinWant(10**adaptor.decimals());

@pytest.fixture(scope='function')
def dai_strategy(a, dai_adaptor, avax, dai, AHv2Farmer):
    strat = a[0].deploy(AHv2Farmer, dai_adaptor.address, sushi_spell, router, pool_dai, dai_id, [avax.address, dai.address], avax.address);
    setup_strategy(a[0], strat, dai_adaptor)
    return strat

@pytest.fixture(scope='function')
def usdc_strategy(a, usdc_adaptor, avax, usdc, AHv2Farmer):
    strat = a[0].deploy(AHv2Farmer, usdc_adaptor.address, sushi_spell, router, pool_usdc, usdt_id, [usdc.address, avax.address], ZERO);
    setup_strategy(a[0], strat, usdc_adaptor)
    return strat

@pytest.fixture(scope='function')
def usdt_strategy(a, usdt_adaptor, avax, usdt, AHv2Farmer):
    strat = a[0].deploy(AHv2Farmer, usdt_adaptor.address, sushi_spell, router, pool_usdt, usdt_id, [avax.address, usdt.address], ZERO);
    setup_strategy(a[0], strat, usdt_adaptor)
    return strat
