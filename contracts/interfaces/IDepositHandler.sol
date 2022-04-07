// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.10;

interface IDepositHandler {
    function depositGvt(
        uint256[3] calldata inAmounts,
        uint256 minAmount,
        address _referral
    ) external;

    function depositPwrd(
        uint256[3] calldata inAmounts,
        uint256 minAmount,
        address _referral
    ) external;
}
