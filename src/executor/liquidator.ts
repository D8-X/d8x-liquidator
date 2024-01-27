import { PerpetualDataHandler, LiquidatorTool } from "@d8x/perpetuals-sdk";
import { ContractReceipt, ContractTransaction, Wallet, utils } from "ethers";
import { providers } from "ethers";
import { Redis } from "ioredis";
import { constructRedis, executeWithTimeout } from "../utils";
import { BotStatus, LiquidateTraderMsg, LiquidatorConfig } from "../types";

export default class Liquidator {
  // objects
  private providers: providers.StaticJsonRpcProvider[];
  private liqTool: { api: LiquidatorTool; busy: boolean }[];
  private redisSubClient: Redis;

  // parameters
  private treasury: string;
  private privateKey: string[];
  private config: LiquidatorConfig;
  private earnings: string | undefined;

  // state
  private q: Set<string> = new Set();
  private lastLiquidateCall: number = 0;

  constructor(pkTreasury: string, pkLiquidators: string[], config: LiquidatorConfig) {
    this.treasury = pkTreasury;
    this.privateKey = pkLiquidators;
    this.config = config;
    this.redisSubClient = constructRedis("executorSubClient");
    this.providers = this.config.rpcExec.map((url) => new providers.StaticJsonRpcProvider(url));
    this.liqTool = this.privateKey.map((pk) => ({
      api: new LiquidatorTool(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig), pk),
      busy: false,
    }));
    if (this.config.rewardsAddress != "" && this.config.rewardsAddress.startsWith("0x")) {
      this.earnings = this.config.rewardsAddress;
    } else {
      this.earnings = undefined;
    }
  }

  /**
   * Attempts to connect to the blockchain using all given RPC providers until one works.
   * An error is thrown if none of the providers works.
   */
  public async initialize() {
    // Create a proxy instance to access the blockchain
    let success = false;
    let i = Math.floor(Math.random() * this.providers.length);
    let tried = 0;
    // try all providers until one works, reverts otherwise
    // console.log(`${new Date(Date.now()).toISOString()}: initializing ...`);
    while (!success && i < this.providers.length && tried <= this.providers.length) {
      console.log(`trying provider ${i} ... `);
      const results = await Promise.allSettled(
        // createProxyInstance attaches the given provider to the object instance
        this.liqTool.map((liq) => liq.api.createProxyInstance(this.providers[i]))
      );
      success = results.every((r) => r.status === "fulfilled");
      i = (i + 1) % this.providers.length;
      tried++;
    }
    if (!success) {
      throw new Error("critical: all RPCs are down");
    }

    // Subscribe to relayed events
    // console.log(`${new Date(Date.now()).toISOString()}: subscribing to account streamer...`);
    await this.redisSubClient.subscribe("block", "LiquidateTrader", (err, count) => {
      if (err) {
        console.log(`${new Date(Date.now()).toISOString()}: redis subscription failed: ${err}`);
        process.exit(1);
      }
      //  else {
      //   console.log(`${new Date(Date.now()).toISOString()}: redis subscription success - ${count} active channels`);
      // }
    });
  }

  /**
   * Subscribes to liquidation opportunities and attempts to liquidate.
   */
  public async run(): Promise<void> {
    // consecutive responses
    let [busy, errors, success, msgs] = [0, 0, 0, 0];

    return new Promise<void>((resolve, reject) => {
      setInterval(async () => {
        if (Date.now() - this.lastLiquidateCall > this.config.liquidateIntervalSecondsMax) {
          await this.liquidate();
        }
      });

      this.redisSubClient.on("message", async (channel, msg) => {
        switch (channel) {
          // case "block": {
          //   if (+msg % 1000 == 0) {
          //     console.log(
          //       JSON.stringify({ busy: busy, errors: errors, success: success, msgs: msgs }, undefined, "  ")
          //     );
          //   }
          //   break;
          // }
          case "LiquidateTrader": {
            const prevCount = this.q.size;
            this.q.add(msg);
            msgs += this.q.size > prevCount ? 1 : 0;
            const res = await this.liquidate();
            if (res == BotStatus.Busy) {
              busy++;
            } else if (res == BotStatus.PartialError) {
              errors++;
            } else if (res == BotStatus.Error) {
              throw new Error(`error`);
            } else {
              // res == BotStatus.Ready
              success++;
            }
            break;
          }
        }
      });
    });
  }

  /**
   * Liquidate traders in q
   */
  public async liquidate() {
    if (Date.now() - this.lastLiquidateCall < this.config.liquidateIntervalSecondsMin * 1_000) {
      return BotStatus.Busy;
    }

    this.lastLiquidateCall = Date.now();
    let attempts = 0;
    let successes = 0;
    const q = [...this.q];

    if (q.length == 0) {
      return BotStatus.Ready;
    }

    const txns: { tx: Promise<ContractTransaction>; botIdx: number; symbol: string; trader: string }[] = [];
    for (const msg of q) {
      let assignedTx = false;
      for (let i = 0; i < this.liqTool.length && !assignedTx; i++) {
        const liq = this.liqTool[i];
        if (!liq.busy) {
          // msg will be attempted by this liquidator
          attempts++;
          this.q.delete(msg);
          liq.busy = true;
          assignedTx = true;
          const { symbol, traderAddr }: LiquidateTraderMsg = JSON.parse(msg);
          txns.push({
            tx: executeWithTimeout(
              liq.api.liquidateTrader(symbol, traderAddr, this.earnings, undefined, {
                gasLimit: 1_000_000,
              }),
              30_000,
              "timeout"
            ),
            botIdx: i,
            symbol: symbol,
            trader: traderAddr,
          });
        }
      }
      if (!assignedTx) {
        // all busy
        break;
      }
    }
    // send txns
    const results = await Promise.allSettled(txns.map(({ tx }) => tx));

    const confirmations: Promise<void>[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successes++;
        console.log({
          symbol: txns[i].symbol,
          orderBook: result.value.to,
          liquidator: result.value.from,
          trader: txns[i].trader,
          txn: result.value.hash,
        });
        confirmations.push(
          executeWithTimeout(
            result.value.wait().then(() => {
              this.liqTool[txns[i].botIdx].busy = false;
            }),
            30_000,
            "timeout"
          )
        );
      } else {
        const liq = this.liqTool[txns[i].botIdx].api.getAddress();
        let prom: Promise<void>;
        const error = result.reason.toString();
        if (error.includes("insufficient funds for intrinsic transaction cost")) {
          prom = this.fundWallets([liq]);
        } else {
          if (!error.includes("gas price too low")) {
            console.log(`${liq} failed with reason ${result.reason}`);
          }
          prom = Promise.resolve();
        }
        confirmations.push(
          prom.then(() => {
            this.liqTool[txns[i].botIdx].busy = false;
          })
        );
      }
    }

    // return cases:
    let res: BotStatus;
    if (successes == 0 && attempts == this.liqTool.length) {
      // all bots are down, either rpc or px service issue
      res = BotStatus.Error;
    } else if (attempts == 0 && q.length > 0) {
      // did not try anything
      res = BotStatus.Busy;
    } else if (successes == 0 && attempts > 0) {
      // tried something but it didn't work
      res = BotStatus.PartialError;
    } else if (successes < attempts) {
      // some attempts worked, others failed
      res = BotStatus.PartialError;
    } else {
      // everything worked or nothing happend
      if (attempts > 0) {
      }
      res = BotStatus.Ready;
    }

    (await Promise.allSettled(confirmations)).map((_result, i) => {
      this.liqTool[txns[i].botIdx].busy = false;
    });

    return res;
  }

  public async fundWallets(addressArray: string[]) {
    const provider = this.providers[Math.floor(Math.random() * this.providers.length)];
    const treasury = new Wallet(this.treasury, provider);
    // min balance should cover 1e7 gas
    const minBalance = utils.parseUnits(`${this.config.maxGasPriceGWei * 1e7}`, "gwei");
    for (let addr of addressArray) {
      const botBalance = await provider.getBalance(addr);
      const treasuryBalance = await provider.getBalance(treasury.address);
      console.log({
        treasuryAddr: treasury.address,
        treasuryBalance: utils.formatUnits(treasuryBalance),
        botAddress: addr,
        botBalance: utils.formatUnits(botBalance),
        minBalance: utils.formatUnits(minBalance),
      });
      if (botBalance.lt(minBalance)) {
        // transfer twice the min so it doesn't transfer every time
        const transferAmount = minBalance.mul(2).sub(botBalance);
        if (transferAmount.lt(treasuryBalance)) {
          const tx = await treasury.sendTransaction({
            to: addr,
            value: transferAmount,
          });
          await tx.wait();
          console.log({ transferAmount: utils.formatUnits(transferAmount), txn: tx.hash });
        } else {
          throw new Error(
            `insufficient balance in treasury ${utils.formatUnits(treasuryBalance)}; send funds to ${treasury.address}`
          );
        }
      }
    }
  }
}
