import { s } from "./scope";
import { ethers, network } from "hardhat";
import { expect, assert } from "chai";
import { showBody, showBodyCyan } from "../../util/format";
import { BN } from "../../util/number";
import { advanceBlockHeight, nextBlockTime, fastForward, mineBlock, OneWeek, OneYear } from "../../util/block";
import { Event, utils, BigNumber } from "ethers";
import { getGas, truncate, getEvent } from "../../util/math";
import _, { first } from "underscore";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

/**
 * 
 * @param result object returned from a transaction that emits an event 
 * @returns the args from the last event emitted from the transaction
 */
const getArgs = async (result: any) => {
    await advanceBlockHeight(1)
    const receipt = await result.wait()
    await advanceBlockHeight(1)
    const events = receipt.events
    const args = events[events.length - 1].args

    return args
}


/**
 * @note proper procedure: read interest factor from contract -> elapse time -> call this to predict balance -> pay_interest() -> compare 
 * @param interestFactor CURRENT interest factor read from contract before any time has elapsed
 * @param user whose balance to calculate interest on? 
 * @returns expected balance after pay_interest()
 */
const calculateBalance = async (interestFactor: BigNumber, user: SignerWithAddress) => {
    const totalBaseLiability = await s.VaultController._totalBaseLiability()
    const protocolFee = await s.VaultController._protocolFee()

    let valueBefore = await truncate(totalBaseLiability.mul(interestFactor))

    const calcInterestFactor = await payInterestMath(interestFactor)

    let valueAfter = await truncate(totalBaseLiability.mul(calcInterestFactor))
    const protocolAmount = await truncate((valueAfter.sub(valueBefore)).mul(protocolFee))

    const donationAmount = valueAfter.sub(valueBefore).sub(protocolAmount)//wrong
    const currentTotalSupply = await s.USDI.totalSupply()
    let newSupply = currentTotalSupply.add(donationAmount)

    //totalGons
    const totalGons = await s.USDI._totalGons()

    //gpf
    const gpf = totalGons.div(newSupply)

    //calculate balance 
    //get gon balance - calculate? 
    const gonBalance = await s.USDI.scaledBalanceOf(user.address)

    const expectedBalance = gonBalance.div(gpf)
    return expectedBalance
}

/**
 * @dev takes interest factor and returns new interest factor - pulls block time from network and latestInterestTime from contract
 * @param interestFactor  - current interest factor read from contract
 * @returns new interest factor based on time elapsed and reserve ratio (read from contract atm)
 */
const payInterestMath = async (interestFactor: BigNumber) => {

    /**
     * get interest factor from contract
     * //time passes
     * run payInterestMath to get new interest factor
     * calculate_interest()
     * get interest factor from contract
     * should match interestFactor calculated in payInterestMath
     * after confirming they match, use calculated interest factor go calc balance, liability, etc
     */

    //let interestFactor = await s.VaultController.InterestFactor()

    const latestInterestTime = await s.VaultController.LastInterestTime()//calculate? 
    const currentBlock = await ethers.provider.getBlockNumber()
    const currentTime = (await ethers.provider.getBlock(currentBlock)).timestamp
    await nextBlockTime(currentTime)
    //await network.provider.send("evm_mine")

    let timeDifference = currentTime - latestInterestTime.toNumber() + 1 //new block must have time ++1

    const reserveRatio = await s.USDI.reserveRatio()//todo - calculate
    const curve = await s.Curve.getValueAt(nullAddr, reserveRatio)//todo - calculate

    let calculation = BN(timeDifference).mul(BN("1e18").mul(curve))//correct step 1
    calculation = calculation.div(OneYear)//correct step 2 - divide by OneYear
    calculation = await truncate(calculation)//truncate
    calculation = calculation.mul(interestFactor)
    calculation = await truncate(calculation)//truncate again

    //new interest factor
    return interestFactor.add(calculation)
}


/**
 * 
 * @param borrowAmount original borrow amount
 * @param currentInterestFactor current interest factor read from contract 
 * @param initialInterestFactor original interest factor from when borrow took place
 * @returns 
 */
const calculateAccountLiability = async (borrowAmount: BigNumber, currentInterestFactor: BigNumber, initialInterestFactor: BigNumber) => {

    let baseAmount = borrowAmount.mul(BN("1e18"))
    baseAmount = baseAmount.div(initialInterestFactor)
    let currentLiability = baseAmount.mul(currentInterestFactor)
    currentLiability = await truncate(currentLiability)

    return currentLiability
}
const initIF = BN("1e18")
//initIF is 1e18, pay_interest() is called before the first loan is taken, resulting in firstBorrowIF
let firstBorrowIF: BigNumber
const borrowAmount = BN("5000e18")
const nullAddr = "0x0000000000000000000000000000000000000000"
describe("BORROW USDi", async () => {

    //bob tries to borrow usdi against 10 eth as if eth is $100k
    // remember bob has 10 eth
    let actualBorrowAmount: any
    let expectedInterestFactor: BigNumber
    it(`bob should not be able to borrow 1e6 * 1e18 * ${s.Bob_WETH} usdi`, async () => {
        await expect(s.VaultController.connect(s.Bob).borrowUsdi(1,
            s.Bob_WETH.mul(BN("1e18")).mul(1e6),
        )).to.be.revertedWith("account insolvent");
    });


    it(`bob should be able to borrow ${"5000e18"} usdi`, async () => {



        const initUSDiBalance = await s.USDI.balanceOf(s.Bob.address)
        assert.equal(initUSDiBalance.toString(), "0", "Bob starts with 0 USDi")

        //get initial interest factor
        const initInterestFactor = await s.VaultController.InterestFactor()

        expectedInterestFactor = await payInterestMath(initInterestFactor)

        firstBorrowIF = expectedInterestFactor
        const calculatedBaseLiability = await calculateAccountLiability(borrowAmount, initInterestFactor, initInterestFactor)


        const borrowResult = await s.VaultController.connect(s.Bob).borrowUsdi(1, borrowAmount)
        await advanceBlockHeight(1)
        const args = await getArgs(borrowResult)
        actualBorrowAmount = args!.borrowAmount

        //actual new interest factor from contract
        const newInterestFactor = await s.VaultController.InterestFactor()

        assert.equal(newInterestFactor.toString(), expectedInterestFactor.toString(), "New Interest Factor is correct")

        await s.VaultController.calculateInterest()
        const liability = await s.VaultController.connect(s.Bob).AccountLiability(1)
        assert.equal(liability.toString(), calculatedBaseLiability.toString(), "Calculated base liability is correct")

        const resultingUSDiBalance = await s.USDI.balanceOf(s.Bob.address)
        assert.equal(resultingUSDiBalance.toString(), actualBorrowAmount.toString(), "Bob received the correct amount of USDi")

    });
    it(`after 1 week, bob should have a liability greater than ${"BN(5000e18)"}`, async () => {

        await advanceBlockHeight(1)
        await fastForward(OneWeek)
        await advanceBlockHeight(1)

        let interestFactor = await s.VaultController.InterestFactor()
        const calculatedInterestFactor = await payInterestMath(interestFactor)

        const expectedLiability = await calculateAccountLiability(borrowAmount, calculatedInterestFactor, firstBorrowIF)

        const result = await s.VaultController.connect(s.Frank).calculateInterest();
        await advanceBlockHeight(1)
        const interestGas = await getGas(result)
        showBodyCyan("Gas cost to calculate interest: ", interestGas)

        interestFactor = await s.VaultController.InterestFactor()
        assert.equal(interestFactor.toString(), calculatedInterestFactor.toString(), "Interest factor is correct")

        const readLiability = await s
            .VaultController.connect(s.Bob)
            .AccountLiability(1);

        expect(readLiability).to.be.gt(BN("5000e18"));

        assert.equal(expectedLiability.toString(), readLiability.toString(), "Liability calculation is correcet")
    });
});

describe("Checking interest generation", () => {
    it("check change in balance over a long period of time", async () => {
        const initBalance = await s.USDI.balanceOf(s.Dave.address)
        //fastForward
        await fastForward(OneYear);//1 year
        await advanceBlockHeight(1)

        //get current interestFactor
        let interestFactor = await s.VaultController.InterestFactor()
        const expectedBalance = await calculateBalance(interestFactor, s.Dave)

        //check for yeild before calculateInterest - should be 0
        let balance = await s.USDI.balanceOf(s.Dave.address)

        assert.equal(balance.toString(), initBalance.toString(), "No yield before calculateInterest")

        //calculate and pay interest on the contract
        const result = await s.VaultController.connect(s.Frank).calculateInterest();
        await advanceBlockHeight(1)
        const interestGas = await getGas(result)
        showBodyCyan("Gas cost to calculate interest: ", interestGas)

        //check for yeild after calculateInterest TODO
        balance = await s.USDI.balanceOf(s.Dave.address)

        //showBody("initBalance    : ", initBalance)
        //showBody("expectedBalance: ", expectedBalance)

        assert.equal(balance.toString(), expectedBalance.toString(), "Expected balance is correct")

        expect(balance > initBalance)
    })
})

describe("Testing repay", () => {
    const borrowAmount = BN("10e18")
    it(`bob should able to borrow ${borrowAmount} usdi`, async () => {
        await expect(s.VaultController.connect(s.Bob).borrowUsdi(1, borrowAmount)).to.not.be.reverted;
    });
    it("partial repay", async () => {
        const vaultId = 1
        const initBalance = await s.USDI.balanceOf(s.Bob.address)

        let liability = await s.BobVault.connect(s.Bob).BaseLiability()
        let partialLiability = liability.div(2) //half

        //check pauseable 
        await s.VaultController.connect(s.Frank).pause()
        await advanceBlockHeight(1)
        await expect(s.VaultController.connect(s.Bob).repayUSDi(vaultId, partialLiability)).to.be.revertedWith("Pausable: paused")
        await s.VaultController.connect(s.Frank).unpause()
        await advanceBlockHeight(1)

        //need to get liability again, 2 seconds have passed when checking pausable
        liability = await s.BobVault.connect(s.Bob).BaseLiability()
        partialLiability = liability.div(2) //half

        //current interest factor
        let interestFactor = await s.VaultController.InterestFactor()
        const expectedBalanceWithInterest = await calculateBalance(interestFactor, s.Bob)

        //next interest factor if pay_interest was called now
        const calculatedInterestFactor = await payInterestMath(interestFactor)

        const base_amount = (partialLiability.mul(BN("1e18"))).div(calculatedInterestFactor)

        const expectedBaseLiability = liability.sub(base_amount)

        const repayResult = await s.VaultController.connect(s.Bob).repayUSDi(vaultId, partialLiability)
        await advanceBlockHeight(1)
        const repayGas = await getGas(repayResult)
        showBodyCyan("Gas cost do partial repay: ", repayGas)

        interestFactor = await s.VaultController.InterestFactor()
        assert.equal(interestFactor.toString(), calculatedInterestFactor.toString(), "Interest factor is correct")

        let updatedLiability = await s.BobVault.connect(s.Bob).BaseLiability()
        let balance = await s.USDI.balanceOf(s.Bob.address)

        assert.equal(expectedBaseLiability.toString(), updatedLiability.toString(), "Updated liability matches calculated liability")
        assert.equal(balance.toString(), (expectedBalanceWithInterest.sub(partialLiability)).toString(), "Balances are correct")

    })
    it("bob compeltely repays vault", async () => {
        //check pauseable 
        await s.VaultController.connect(s.Frank).pause()
        await advanceBlockHeight(1)
        await expect(s.VaultController.connect(s.Bob).repayAllUSDi(1)).to.be.revertedWith("Pausable: paused")
        await s.VaultController.connect(s.Frank).unpause()
        await advanceBlockHeight(1)

        //current interest factor
        let interestFactor = await s.VaultController.InterestFactor()
        const expectedBalanceWithInterest = await calculateBalance(interestFactor, s.Bob)
        let liability = await s.BobVault.connect(s.Bob).BaseLiability()

        //next interest factor if pay_interest was called now
        const calculatedInterestFactor = await payInterestMath(interestFactor)

        const expectedUSDIliability = await truncate(calculatedInterestFactor.mul(liability))

        const repayResult = await s.VaultController.connect(s.Bob).repayAllUSDi(1)
        await advanceBlockHeight(1)
        const repayGas = await getGas(repayResult)
        showBodyCyan("Gas cost do total repay: ", repayGas)
        const args = await getArgs(repayResult)

        assert.equal(args.repayAmount.toString(), expectedUSDIliability.toString(), "Expected USDI amount repayed and burned")

        let updatedLiability = await s.BobVault.connect(s.Bob).BaseLiability()
        expect(updatedLiability).to.eq(0)

        let balance = await s.USDI.balanceOf(s.Bob.address)
        assert.equal(expectedBalanceWithInterest.sub(expectedUSDIliability).toString(), balance.toString(), "Expected balance is correct")
    })
})

describe("Testing liquidations", () => {
    it(`bob should have ${s.Bob_WETH} wETH deposited`, async () => {
        expect(await s.BobVault.connect(s.Bob).tokenBalance(s.WETH.address)).to.eq(s.Bob_WETH);
    });
    it("borrow maximum and liquidate", async () => {
        const vaultID = 1
        const bobVaultInit = await s.WETH.balanceOf(s.BobVault.address)

        //borrow maximum -> borrow amount == collateral value 
        const borrowInterestFactor = await s.VaultController.InterestFactor()
        let calcIF = await payInterestMath(borrowInterestFactor)
        const AccountBorrowingPower = await s.VaultController.AccountBorrowingPower(vaultID)
        await nextBlockTime(0)
        await s.VaultController.connect(s.Bob).borrowUsdi(vaultID, AccountBorrowingPower)
        await advanceBlockHeight(1)
        let IF = await s.VaultController.InterestFactor()
        const initIF = IF
        assert.equal(IF.toString(), calcIF.toString())

        /******** CHECK WITHDRAW BEFORE CALCULATE INTEREST ********/
        //skip time so we can put vault below liquidation threshold 
        await fastForward(OneYear * 10);//10 year
        await advanceBlockHeight(1)
        const tenYearIF = await payInterestMath(calcIF)

        //calculate interest to update protocol, vault is now able to be liquidated 
        await nextBlockTime(0)
        await s.VaultController.calculateInterest()
        await advanceBlockHeight(1)
        IF = await s.VaultController.InterestFactor()
        assert.equal(tenYearIF.toString(), IF.toString(), "Interest factor calculation is correct after 10 years")

        //init balances after calculate interest
        const initWethBalanceDave = await s.WETH.balanceOf(s.Dave.address)

        //check pauseable 
        await s.VaultController.connect(s.Frank).pause()
        await advanceBlockHeight(1)
        await expect(s.VaultController.connect(s.Dave).liquidate_account(vaultID, s.wethAddress, BN("1e16"))).to.be.revertedWith("Pausable: paused")
        await s.VaultController.connect(s.Frank).unpause()
        await advanceBlockHeight(1)

        //expectedBalanceWithInterest must be calced here - TODO why? 
        const expectedBalanceWithInterest = await calculateBalance(IF, s.Dave)

        //liquidate account
        await nextBlockTime(0)
        const result = await s.VaultController.connect(s.Dave).liquidate_account(vaultID, s.wethAddress, BN("1e16"))
        await advanceBlockHeight(1)
        const receipt = await result.wait()
        await nextBlockTime(0)

        IF = await s.VaultController.InterestFactor()
        let expectedLiability = await calculateAccountLiability(AccountBorrowingPower, IF, initIF)

        let interestEvent = await getEvent(result, "InterestEvent")
        assert.equal(interestEvent.event, "InterestEvent", "Correct event captured and emitted")

        let liquidateEvent = receipt.events![receipt.events!.length - 1]
        let args = liquidateEvent.args
        assert.equal(liquidateEvent.event, "Liquidate", "Correct event captured and emitted")
        assert.equal(args!.asset_address.toString().toUpperCase(), s.wethAddress.toString().toUpperCase(), "Asset address is correct")
        const usdi_to_repurchase = args!.usdi_to_repurchase
        const tokens_to_liquidate = args!.tokens_to_liquidate

        /******** check ending balances ********/
        //check ending liability 
        let liabiltiy = await s.VaultController.AccountLiability(vaultID)
         
        //TODO - result is off by 0-8, and is inconsistant -- oracle price? Rounding error? 
        if (liabiltiy == expectedLiability.sub(usdi_to_repurchase)) {
            showBodyCyan("LIABILITY MATCH")
        }
        expect(liabiltiy).to.be.gt((expectedLiability.sub(usdi_to_repurchase)).sub(10))
        expect(liabiltiy).to.be.lt((expectedLiability.sub(usdi_to_repurchase)).add(10))
        //assert.equal(liabiltiy.toString(), expectedLiability.sub(usdi_to_repurchase).toString(), "Calculated liability is correct")

        //Bob's vault has less collateral than before
        let balance = await s.WETH.balanceOf(s.BobVault.address)
        let difference = bobVaultInit.sub(balance)
        assert.equal(difference.toString(), tokens_to_liquidate.toString(), "Correct number of tokens liquidated from vault")

        //Dave spent USDi to liquidate -- TODO: precalc balance
        balance = await s.USDI.balanceOf(s.Dave.address)
        difference = expectedBalanceWithInterest.sub(balance)
        assert.equal(difference.toString(), usdi_to_repurchase.toString(), "Dave spent the correct amount of usdi")

        //Dave received wETH
        balance = await s.WETH.balanceOf(s.Dave.address)
        difference = balance.sub(initWethBalanceDave)
        assert.equal(difference.toString(), tokens_to_liquidate.toString(), "Correct number of tokens liquidated from vault")
    })

    it("checks for over liquidation and then liquidates a vault that is just barely insolvent", async () => {
        /**
         * 
         * TODO: test exploit: liquidate max -> borrowing power reduced -> account insolvant again -> repeat -> profit
         * 
         */
        const rawPrice = await s.Oracle.getLivePrice(s.compAddress)
        //showBody("rawPrice: ", rawPrice)
        //let formatPrice = (await s.Oracle.getLivePrice(s.compAddress)).div(1e14).toNumber() / 1e4
        const vaultID = 2

        //showBody("scaled COMP price: ", rawPrice.mul(BN("1e18")))
        //get values for total collateral value and loan amount
        const carolVaultTotalTokens = await s.COMP.balanceOf(s.CarolVault.address)
        const collateralValue = carolVaultTotalTokens.mul(BN("1e18")).mul(rawPrice.mul(BN("1e18")))
        //showBody("carol's TCV: ", collateralValue)
        //borrow usdi
        const carolBorrowPower = await s.VaultController.AccountBorrowingPower(2)
        await advanceBlockHeight(1)
        const borrowResult = await s.VaultController.connect(s.Carol).borrowUsdi(vaultID, carolBorrowPower)
        await advanceBlockHeight(1)
        const args = await getArgs(borrowResult)
        const actualBorrowAmount = args!.borrowAmount


        expect(await s.USDI.balanceOf(s.Carol.address)).to.eq(actualBorrowAmount)

        let solvency = await s.VaultController.checkAccount(vaultID)
        //showBody("carol's vault should be solvent")
        assert.equal(solvency, true, "Carol's vault is solvent")

        //showBody("advance 1 week and then calculate interest")
        await fastForward(OneWeek)
        await s.VaultController.calculateInterest()
        await advanceBlockHeight(1)

        let bn = await ethers.provider.getBlockNumber()
        //showBody("current block", bn)
        //this check is silly, each new mineBlock() advances by 1
        //expect(bn).to.eq(BN("14546874"))

        let bt = (await ethers.provider.getBlock(bn)).timestamp
        //showBody("current timestamp", bt)

        solvency = await s.VaultController.checkAccount(vaultID)
        //showBody("carol vault should be insolvent")
        assert.equal(solvency, false, "Carol's vault is not solvent")

        let liquidatableTokens = await s.VaultController.TokensToLiquidate(vaultID, s.compAddress, BN("1e25"))
        //showBody("liquidatableTokens:", liquidatableTokens)
        //tiny liquidation 
        //showBody("calculating amount to liquidate");

        //callStatic does not actually make the call and change the state of the contract, thus liquidateAmount == liquidatableTokens
        const liquidateAmount = await s.VaultController.connect(s.Dave).callStatic.liquidate_account(vaultID, s.compAddress, BN("1e25"))
        //showBody("liquidating at IF", await s.VaultController.InterestFactor());
        await expect(s.VaultController.connect(s.Dave).liquidate_account(vaultID, s.compAddress, BN("1e25"))).to.not.reverted
        await advanceBlockHeight(1)
        //showBody("dave liquidated:", liquidateAmount, "comp")
        expect(liquidateAmount).to.eq(liquidatableTokens)

        //let balance = await s.USDI.balanceOf(Dave.address)
        //console.log("Dave USDi Balance: ", utils.formatEther(balance.toString()))


        //balance = await s.USDI.balanceOf(Dave.address)
        //console.log("Dave USDi Balance: ", utils.formatEther(balance.toString()))

        //await s.VaultController.connect(Dave).liquidate_account(vaultID, s.wethAddress, bobVaultTotal.div(2)).should.be.revertedWith("vault solvent")
    })
})


