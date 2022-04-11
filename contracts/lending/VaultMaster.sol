// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../token/IUSDI.sol";
import "../oracle/OracleMaster.sol";

import "./IVaultMaster.sol";
import "./Vault.sol";
import "./IVault.sol";

import "../_external/Ownable.sol";
import "../_external/IERC20.sol";
import "../_external/compound/ExponentialNoError.sol";

import "hardhat/console.sol";

contract VaultMaster is IVaultMaster, ExponentialNoError, Ownable {
    address[] public _enabledTokens;

    address public _oracleMasterAddress;
    OracleMaster _oracleMaster;

    address public _usdiAddress;
    IUSDI _usdi;

    uint256 public _vaultsMinted;
    uint256 public _tokensRegistered;

    uint256 public _totalBaseLiability;

    uint256 public _lastInterestTime;

    // usdi owed = _interestFactor * baseLiability;
    // this is the interest factor * 1e18
    uint256 public _e18_interestFactor;

    uint256 public _e4_liquidatorShare;

    event Liquidate(
        uint256 vaultId,
        address asset_address,
        uint256 max_usdi,
        uint256 usdi_to_repurchase,
        uint256 tokens_to_liquidate
    );

    event Interest(uint256 epoch, uint256 amount);

    // mapping of vault id to vault address
    mapping(uint256 => address) public _vaultId_vaultAddress;

    // mapping of token address to token id
    mapping(address => uint256) public _tokenAddress_tokenId;

    //mapping of tokenId to the LTV*1e4
    mapping(uint256 => uint256) public _tokenId_tokenLTVe4;

    //mapping of tokenId to its corresponding oracleAddress (which are addresses)
    mapping(uint256 => address) public _tokenId_oracleAddress;

    //mapping of token address to its corresponding liquidation incentive
    mapping(address => uint256) public _tokenAddress_liquidationIncentivee4;

    constructor() Ownable() {
        _vaultsMinted = 0;
        _tokensRegistered = 0;
        _e18_interestFactor = 1e18; // initialize at 1e18;
        _totalBaseLiability = 0;

        _lastInterestTime = block.timestamp;
    }

    function mint_vault() public returns (address) {
        _vaultsMinted = _vaultsMinted + 1;
        address vault_address = address(
            new Vault(_vaultsMinted, msg.sender, address(this), _usdiAddress)
        );
        _vaultId_vaultAddress[_vaultsMinted] = vault_address;
        return vault_address;
    }

    function register_usdi(address usdi_address) external onlyOwner {
        _usdiAddress = usdi_address;
        _usdi = IUSDI(usdi_address);
    }

    function register_oracle_master(address master_oracle_address)
        external
        onlyOwner
    {
        _oracleMasterAddress = master_oracle_address;
        _oracleMaster = OracleMaster(_oracleMasterAddress);
    }

    function getInterestFactor() external view override returns (uint256) {
        return _e18_interestFactor;
    }

    function register_erc20(
        address token_address,
        uint256 LTVe4,
        address oracle_address,
        uint256 liquidationIncentivee4
    ) external onlyOwner {
        require(
            _oracleMaster._relays(oracle_address) != address(0x0),
            "oracle does not exist"
        );
        require(
            _tokenAddress_tokenId[token_address] == 0,
            "token already registered"
        );
        _tokensRegistered = _tokensRegistered + 1;
        _tokenAddress_tokenId[token_address] = _tokensRegistered;
        _tokenId_oracleAddress[_tokensRegistered] = oracle_address;
        _enabledTokens.push(token_address);
        _tokenId_tokenLTVe4[_tokensRegistered] = LTVe4;
        _tokenAddress_liquidationIncentivee4[
            token_address
        ] = liquidationIncentivee4;
    }

    function update_registered_erc20(
        address token_address,
        uint256 LTVe4,
        address oracle_address,
        uint256 liquidationIncentivee4
    ) external onlyOwner {
        require(
            _oracleMaster._relays(oracle_address) != address(0x0),
            "oracle does not exist"
        );
        require(
            _tokenAddress_tokenId[token_address] != 0,
            "token is not registered"
        );
        _tokenId_oracleAddress[_tokensRegistered] = oracle_address;
        _tokenId_tokenLTVe4[_tokensRegistered] = LTVe4;
        _tokenAddress_liquidationIncentivee4[
            token_address
        ] = liquidationIncentivee4;
    }

    function check_account(uint256 id) external view override returns (bool) {
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);
        uint256 total_liquidity_value = get_vault_borrowing_power(vault);
        uint256 usdi_liability = (vault.getBaseLiability() *
            _e18_interestFactor) / 1e18;
        return (total_liquidity_value >= usdi_liability);
    }

    function account_borrowing_power(uint256 id)
        external
        view
        returns (uint256)
    {
        return get_vault_borrowing_power(IVault(_vaultId_vaultAddress[id]));
    }

    function borrow_usdi(uint256 id, uint256 amount) external override {
        pay_interest();
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);
        require(
            msg.sender == vault.getMinter(),
            "only vault creator may borrow from their vault"
        );

        Exp memory interest_factor = Exp({mantissa: _e18_interestFactor});
        uint256 base_amount = ExponentialNoError.div_(amount, interest_factor);
        uint256 base_liability = vault.increase_liability(base_amount);
        _totalBaseLiability = _totalBaseLiability + base_amount;
        uint256 usdi_liability = ExponentialNoError.mul_ScalarTruncate(
            interest_factor,
            base_liability
        );
        //console.log("amount passed to borrow_usdi: ", amount);
        //console.log("usdi_liability: ", usdi_liability);
        uint256 total_liquidity_value = get_vault_borrowing_power(vault);
        //console.log("total_liquidity_value: ", total_liquidity_value);
        bool solvency = (total_liquidity_value >= usdi_liability);
        require(solvency, "this borrow would make your account insolvent");

        _usdi.vault_master_mint(msg.sender, amount);
    }

    function get_account_liability(uint256 id)
        external
        view
        override
        returns (uint256)
    {
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);

        return (vault.getBaseLiability() * _e18_interestFactor) / 1e18;
    }

    function repay_usdi(uint256 id, uint256 amount) external override {
        pay_interest();
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);

        Exp memory interest_factor = Exp({mantissa: _e18_interestFactor});
        //console.log("Amount: ", amount);
        //console.log("e18 IF: ", _e18_interestFactor);
        uint256 base_amount = ExponentialNoError.div_(amount, interest_factor);
        _totalBaseLiability = _totalBaseLiability - base_amount;
        require(
            base_amount <= vault.getBaseLiability(),
            "cannot repay more than is borrowed"
        );

        vault.decrease_liability(base_amount);

        _usdi.vault_master_burn(msg.sender, base_amount);
    }

    function repay_all_usdi(uint256 id) external override {
        pay_interest();
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);

        Exp memory interest_factor = Exp({mantissa: _e18_interestFactor});
        uint256 usdi_liability = ExponentialNoError.mul_ScalarTruncate(
            interest_factor,
            vault.getBaseLiability()
        );
        vault.decrease_liability(vault.getBaseLiability());
        _usdi.vault_master_burn(msg.sender, usdi_liability);
    }

    function getScaledPrice(
        Exp memory price,
        address asset_address,
        uint256 token_Id
    ) internal view returns (uint256 scaled_down_price) {
        scaled_down_price = ExponentialNoError.mul_ScalarTruncate(
            price,
            (_tokenAddress_liquidationIncentivee4[asset_address] -
                _tokenId_tokenLTVe4[token_Id])
        );
        console.log("scaled_down_price: ", scaled_down_price);
    }

    function getUsdiToRepurchase(
        Exp memory price,
        address asset_address,
        uint256 tokens_to_liquidate
    ) internal view returns (uint256 usdi_to_repurchase) {
        usdi_to_repurchase =
            (
                ExponentialNoError.mul_ScalarTruncate(
                    price,
                    _tokenAddress_liquidationIncentivee4[asset_address]
                )
            ) *
            tokens_to_liquidate;
    }

    function liquidate_account(
        uint256 id,
        address asset_address,
        uint256 max_usdi
    ) external override returns (uint256) {
        pay_interest();
        address vault_address = _vaultId_vaultAddress[id];
        require(vault_address != address(0x0), "vault does not exist");
        IVault vault = IVault(vault_address);
        uint256 vault_borrowing_power = get_vault_borrowing_power(vault);
        //if this balance is greater than the usdi liability, we just return 0 (nothing to liquidate);
        uint256 usdi_liability = (vault.getBaseLiability() *
            _e18_interestFactor) / 1e18;
        if (vault_borrowing_power >= usdi_liability) {
            console.log("BALANCE NOT GREATER THAN LIABILITY");
            return 0;
        }
        // however, if it is a positive number, then we can begin the liquidation process
        // we liquidate the user until their total value = total borrow
        uint256 deficit = usdi_liability - vault_borrowing_power;
        //get the price of the asset
        uint256 asset_price = uint256(
            _oracleMaster.get_live_price(asset_address)
        );
        require(asset_price != 0, "no oracle price");
        Exp memory price = Exp({mantissa: asset_price}); // remember that our prices are all in 1e18 terms
        //lower price to give liquidator incentive
        uint256 token_Id = _tokenAddress_tokenId[asset_address];
        //uint256 scaled_down_price = getScaledPrice(price, asset_address, token_Id);

        console.log("deficit: ", deficit);

        //solve for ideal amount
        uint256 tokens_to_liquidate = ExponentialNoError.div_(
            getScaledPrice(price, asset_address, token_Id), //numerator (big number)
            deficit //denominator (small number)
        );

        uint256 usdi_to_repurchase = getUsdiToRepurchase(
            price,
            asset_address,
            tokens_to_liquidate
        );
        console.log("DIVIDE");
        console.log("usdi_to_repurchase: ", usdi_to_repurchase);
        console.log("tokens_to_liquidate: ", tokens_to_liquidate);
        uint256 liquidate_price = ExponentialNoError.div_(
            usdi_to_repurchase,
            tokens_to_liquidate
        );
        //check for partial fill
        if (usdi_to_repurchase > max_usdi) {
            usdi_to_repurchase = max_usdi;

            tokens_to_liquidate = ExponentialNoError.div_(
                usdi_to_repurchase,
                liquidate_price
            );
        }

        //uint256 vault_balance = vault.getBalances(asset_address);

        //if ideal amount isnt possible update with vault balance
        if (tokens_to_liquidate > vault.getBalances(asset_address)) {
            tokens_to_liquidate = vault.getBalances(asset_address);
            usdi_to_repurchase = (liquidate_price * tokens_to_liquidate) / 1e18;
        }

        //console.log("usdi_to_repurchase: ", usdi_to_repurchase);
        //console.log("tokens_to_liquidate: ", tokens_to_liquidate);
        //console.log("asset_price_with_incentive: ", asset_price_with_incentive);

        //get the vault back to a healthy ratio
        vault.decrease_liability(usdi_to_repurchase);

        //decrease liquidators balance usdi
        _usdi.vault_master_burn(msg.sender, usdi_to_repurchase);

        // finally, we deliver the tokens to the liquidator
        vault.masterTransfer(asset_address, msg.sender, tokens_to_liquidate);

        emit Liquidate(
            id,
            asset_address,
            max_usdi,
            usdi_to_repurchase,
            tokens_to_liquidate
        );

        return tokens_to_liquidate;
    }

    function get_vault_borrowing_power(IVault vault)
        private
        view
        returns (uint256)
    {
        uint256 total_liquidity_value = 0;
        for (uint256 i = 1; i <= _tokensRegistered; i++) {
            address token_address = _enabledTokens[i - 1];
            uint256 raw_price = uint256(
                _oracleMaster.get_live_price(token_address)
            );
            if (raw_price != 0) {
                uint256 balance = vault.getBalances(token_address);
                uint256 token_value = (ExponentialNoError.mul_ScalarTruncate(
                    Exp({mantissa: raw_price}),
                    balance
                ) * _tokenId_tokenLTVe4[i]) / 1e4; // //
                total_liquidity_value = total_liquidity_value + token_value;
            }
        }
        return total_liquidity_value;
    }

    function calculate_interest() external override {
        pay_interest();
    }

    function pay_interest() private {
        uint256 timeDifference = block.timestamp - _lastInterestTime;
        uint256 e18_reserve_ratio = _usdi.reserveRatio();
        uint256 e18_curve = 1e16;
        if (e18_reserve_ratio < (1e17 * 4)) {
            e18_curve = 19 * 1e16 - (9 * 1e18 * e18_reserve_ratio) / 20e18;
        }
        if (e18_reserve_ratio < (1e17 * 2)) {
            e18_curve = 19 * 1e17 - (9 * 1e18 * e18_reserve_ratio) / 1e18;
        }

        uint256 e18_factor_increase = (ExponentialNoError.mul_ScalarTruncate(
            Exp({mantissa: (timeDifference * 1e18) / (365 days + 6 hours)}),
            e18_curve
        ) * _e18_interestFactor) / 1e18;

        uint256 valueBefore = (_totalBaseLiability * _e18_interestFactor) /
            1e18;
        _e18_interestFactor = _e18_interestFactor + e18_factor_increase;
        uint256 valueAfter = (_totalBaseLiability * _e18_interestFactor) / 1e18;
        if (valueAfter > valueBefore) {
            _usdi.vault_master_donate(valueAfter - valueBefore);
        }

        _lastInterestTime = block.timestamp;
        emit Interest(block.timestamp, e18_factor_increase);
    }
}
