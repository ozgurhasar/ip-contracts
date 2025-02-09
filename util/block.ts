import { network, ethers } from "hardhat";
import * as dotenv from "dotenv";

export const advanceBlockHeight = async (blocks: number) => {
    for (let i = 0; i < blocks; i++) {
        await network.provider.send("evm_mine")
    }
    return
};

export const fastForward = async (time: number) => {
    await network.provider.request({
        method: "evm_increaseTime",
        params: [time],
    })
    return
};

export const mineBlock = async () => {
    await fastForward(15)
    await advanceBlockHeight(1)
    return
}

export const currentBlock = async () => {
    const currentBlock = await ethers.provider.getBlockNumber()
    return await ethers.provider.getBlock(currentBlock)
}

//set next TX timestamp to be current time + 1, cannot set next TX to be current time
export const nextBlockTime = async (blockTime:number) => {
    if(blockTime == 0){
        let currentTime = await currentBlock()
        blockTime = currentTime.timestamp
    }
    
    await network.provider.send("evm_setNextBlockTimestamp", [blockTime + 1])
}

export const reset = async (block: number) => {
    dotenv.config();

    //pass 0 to return to starting block
    if (block == 0) {
        block = 14546835
    }
    await network.provider.request({
        method: "hardhat_reset",
        params: [
            {
                forking: {
                    jsonRpcUrl: process.env.MAINNET_URL!,
                    blockNumber: block
                },
            },
        ],
    });
}

export const OneYear = 60 * 60 * 24 * 365.25
export const OneWeek = 60 * 60 * 24 * 7;
export const OneDay = 60 * 60 * 24;
