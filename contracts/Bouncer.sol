// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IVault {
    function setUserAllowance(address _user, uint256 _amount) external;
}

/// notice Airdrop contract for the stand alone vault
///     Provided merkleRoot will allow users to make an allowance claim against
///     the Gro Labs stand alone vaults - one drop allows to claim the same amount against all
///     available vaults, subsequent drops will allow the user to add to their current allowance.
///     Note that the airdrops in this contract wont be normalized to any specific token, and its
///     the sVaults responsibility to correctly translate the amount to the correct decimal, e.g.:
///         Aridrop for user 1: 10000
///         Claim against daiVault will result in an allowance of 10000 * 1E18
///         Claim against usdcVault will result in an allowance of 10000 * 1E6
///         etc...
contract Bouncer is Ownable {

    bytes32 public root;
    mapping(address => bool) public vaults;
    mapping(uint256 => address) public testVaults;
    mapping(address => mapping(address => uint128)) public claimed;

    uint256 public numberOfVaults;

    event LogNewDrop(bytes32 merkleRoot);
    event LogClaim(address indexed account, address indexed vault, uint128 amount);
    event LogVaultStatus(address indexed vault, bool status);

    function addVault(address _vault, bool _status) public onlyOwner {
        vaults[_vault] = _status;
        if (_status) {
            testVaults[numberOfVaults] = _vault;
            numberOfVaults += 1;
        }
        emit LogVaultStatus(_vault, _status);
    }

    function newDrop(bytes32 merkleRoot) external onlyOwner {
        root = merkleRoot;
        emit LogNewDrop(merkleRoot);
    }

    function getClaimed(address vault, address account) public view returns (uint128) {
        return claimed[vault][account];
    }

    function claim(
        uint128 amount,
        address _vault,
        bytes32[] calldata merkleProof
    ) external {
        // Verify the merkle proof.
        bytes32 node = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(merkleProof, root, node), "claim: Invalid proof");
        uint128 _claimed = getClaimed(_vault, msg.sender);
        require( _claimed < amount , "claim: full allowance already claimed");
        uint128 _amount = amount - _claimed;

        // Mark it claimed and send the token.
        IVault(_vault).setUserAllowance(msg.sender, _amount);
        claimed[_vault][msg.sender] = amount;

        emit LogClaim(msg.sender, _vault, _amount);
    }

    function verifyDrop(
        uint128 amount,
        bytes32[] calldata merkleProof
    ) external view returns (bool) {
        // Verify the merkle proof.
        bytes32 node = keccak256(abi.encodePacked(msg.sender, amount));
        return MerkleProof.verify(merkleProof, root, node);
    }
}