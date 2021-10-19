// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

contract Constants {
    uint8 internal constant DEFAULT_DECIMALS = 18;
    uint256 internal constant DEFAULT_DECIMALS_FACTOR = uint256(10)**DEFAULT_DECIMALS;
    uint8 internal constant PERCENTAGE_DECIMALS = 4;
    uint256 internal constant PERCENTAGE_DECIMAL_FACTOR = uint256(10)**PERCENTAGE_DECIMALS;
}
