import { expect, assert } from "chai";
import { ethers, network, tenderly } from "hardhat";
import { stealMoney } from "../../../util/money";
import { showBody } from "../../../util/format";
import { BN } from "../../../util/number";
import { s } from ".././scope";
import { advanceBlockHeight, reset, mineBlock } from "../../../util/block";
import { IERC20__factory, IVOTE__factory } from "../../../typechain-types";
//import { assert } from "console";

require("chai").should();
//*
// Initial Balances:
// Andy: 100,000,000 usdc ($100) 6dec
// Bob: 10,000,000,000,000,000,000 weth (10 weth) 18dec
// Carol: 100,000,000,000,000,000,000 (100 comp), 18dec
// Dave: 10,000,000,000 usdc ($10,000) 6dec
//
// andy is a usdc holder. he wishes to deposit USDC to hold USDI
// bob is an eth holder. He wishes to deposit his eth and borrow USDI
// carol is a comp holder. she wishes to deposit her comp and then vote
// dave is a liquidator. he enjoys liquidating, so he's going to try to liquidate Bob

// configurable variables

let usdc_minter = "0xe78388b4ce79068e89bf8aa7f218ef6b9ab0e9d0";
let comp_minter = "0xf977814e90da44bfa03b6295a0616a897441acec";
let dydx_minter = "0xf977814e90da44bfa03b6295a0616a897441acec";
let ens_minter = "0xf977814e90da44bfa03b6295a0616a897441acec";
let aave_minter = "0xf977814e90da44bfa03b6295a0616a897441acec";
let tribe_minter = "0xf977814e90da44bfa03b6295a0616a897441acec";
let weth_minter = "0xe78388b4ce79068e89bf8aa7f218ef6b9ab0e9d0";

let carol_voting_address = "0x1F2AB8Ac759Fb0E3185630277A554Ae3110bF530";

if (process.env.TENDERLY_KEY) {
    if (process.env.TENDERLY_ENABLE == "true") {
        let provider = new ethers.providers.Web3Provider(tenderly.network())
        ethers.provider = provider
    }
}


describe("hardhat settings", () => {
    it("reset hardhat network each run", async () => {
        expect(await reset(0)).to.not.throw;
    });
    it("set automine OFF", async () => {
        expect(await network.provider.send("evm_setAutomine", [false])).to.not
            .throw;
    });

});

describe("Token Setup", () => {
    it("connect to signers", async () => {
        let accounts = await ethers.getSigners();
        s.Frank = accounts[0];
        s.Andy = accounts[1];
        s.Bob = accounts[2];
        s.Carol = accounts[3];
        s.Dave = accounts[4];
        s.Eric = accounts[5];
        s.Gus = accounts[6];
        s.Hector = accounts[7];
    });
    it("Connect to existing contracts", async () => {
        s.USDC = IERC20__factory.connect(s.usdcAddress, s.Frank);
        
    });
    it("Should succesfully transfer money", async () => {
        showBody(`stealing ${s.Andy_USDC} to andy from ${s.usdcAddress}`);
        await expect(
            stealMoney(usdc_minter, s.Andy.address, s.usdcAddress, s.Andy_USDC)
        ).to.not.be.reverted;
        showBody(`stealing ${s.Dave_USDC} to dave from ${s.usdcAddress}`);
        await expect(
            stealMoney(usdc_minter, s.Dave.address, s.usdcAddress, s.Dave_USDC)
        ).to.not.be.reverted;        
        showBody(`stealing ${s.Bob_USDC} usdc to bob from ${s.usdcAddress}`);
        await expect(
            stealMoney(usdc_minter, s.Bob.address, s.usdcAddress, s.Bob_USDC)
        ).to.not.be.reverted
        await mineBlock();

        let balance = await s.USDC.balanceOf(s.Bob.address)
        expect(balance).to.eq(s.Bob_USDC)
        showBody("BOB balance: ", balance)

    });
});
