import pytest
from brownie import interface, chain
import brownie
from user import *
from token import *

LARGE_NUMBER = int(1E18*1E10)

def setup_strategy(AHGov, homora, strategy, avax):
    homora.functions.setWhitelistUsers([strategy.address], [True]).transact({'from': AHGov})
    homora.functions.setCreditLimits([[strategy.address, avax.address, LARGE_NUMBER]]).transact({'from': AHGov})

def setup_adaptor(token, investor, bouncer, adaptor):
    token.functions.approve(adaptor.address, LARGE_NUMBER).transact({'from': investor.address})
    adaptor.setUserAllowance(investor, LARGE_NUMBER, {'from': bouncer})

def test_harvest(admin, investor1, AHGov, bouncer, dai, avax, daiBank, homoraBank, dai_strategy, dai_adaptor):
    setup_adaptor(dai, investor1, bouncer, dai_adaptor)
    setup_strategy(AHGov, homoraBank, dai_strategy, avax)

    amount = 10000;
    amount_norm = amount * 1E18;
    dai_adaptor.deposit(amount_norm, {'from': investor1})
    assert dai_strategy.harvestTrigger(0) == True
    dai_adaptor.strategyHarvest(0, {'from': admin})
    pos = dai_strategy.activePosition()
    assert dai_strategy.harvestTrigger(0) == False

    sec_amount = 9000;
    sec_amount_norm = sec_amount * 1E18;
    dai_strategy.setMinWant(amount_norm);

    dai_adaptor.deposit(sec_amount_norm, {'from': investor1})
    assert dai_strategy.harvestTrigger(0) == False
    return
