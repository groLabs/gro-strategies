// SPDX-License-Identifier: AGPLv3
pragma solidity 0.8.4;

import "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IVault {
    function setUserAllowance(address _user, uint256 _amount) external;
}

contract Bouncer is Ownable {

    bytes32 public root;
    mapping(address => bool) public vaults;
    mapping(uint256 => address) public testVaults;
    mapping(address => mapping(address => bool)) public claimed;

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

    function isClaimed(address vault, address account) public view returns (bool) {
        return claimed[vault][account];
    }

    function claim(
        uint128 amount,
        address _vault,
        bytes32[] calldata merkleProof
    ) external {
        require(!isClaimed(_vault, msg.sender), "claim: Drop already claimed");
        // Verify the merkle proof.
        bytes32 node = keccak256(abi.encodePacked(msg.sender, amount));
        require(MerkleProof.verify(merkleProof, root, node), "claim: Invalid proof");

        // Mark it claimed and send the token.
        IVault(_vault).setUserAllowance(msg.sender, amount);
        claimed[_vault][msg.sender] = true;

        emit LogClaim(msg.sender, _vault, amount);
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
