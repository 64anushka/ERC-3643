// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// Test settlement cash ("EURd"). Owner-mintable ERC-20 with 6 decimals,
/// used as the cash leg of DVDTransferManager swaps in the SCO Bond PoV.
contract MockCashToken is ERC20, Ownable {
    uint8 private constant CASH_DECIMALS = 6;

    constructor(address _owner) ERC20("Euro Digital", "EURd") {
        transferOwnership(_owner);
    }

    function decimals() public pure override returns (uint8) {
        return CASH_DECIMALS;
    }

    function mint(address _to, uint256 _amount) external onlyOwner {
        _mint(_to, _amount);
    }
}
