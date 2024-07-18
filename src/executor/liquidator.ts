import { PerpetualDataHandler, LiquidatorTool } from "@d8x/perpetuals-sdk";
import { TransactionResponse, Wallet, formatUnits } from "ethers";
import { JsonRpcProvider } from "ethers";
import { Redis } from "ioredis";
import { constructRedis, executeWithTimeout } from "../utils";
import { BotStatus, LiquidateTraderMsg, LiquidatorConfig } from "../types";
import { Metrics } from "./metrics";

export default class Liquidator {
  // objects
  private providers: JsonRpcProvider[];
  private bots: { api: LiquidatorTool; busy: boolean }[];
  private redisSubClient: Redis;

  // parameters
  private treasury: string;
  private privateKey: string[];
  private config: LiquidatorConfig;
  private earnings: string | undefined;

  // state
  private q: Set<string> = new Set();
  private lastLiquidateCall: number = 0;
  private locked: Set<string> = new Set();

  protected metrics: Metrics;

  constructor(pkTreasury: string, pkLiquidators: string[], config: LiquidatorConfig) {
    this.metrics = new Metrics();
    this.metrics.start();

    this.treasury = pkTreasury;
    this.privateKey = pkLiquidators;
    this.config = config;
    this.redisSubClient = constructRedis("executorSubClient");
    this.providers = this.config.rpcExec.map((url) => new JsonRpcProvider(url));

    const sdkConfig = PerpetualDataHandler.readSDKConfig(this.config.sdkConfig);

    // Use price feed endpoints from user specified config
    if (this.config.priceFeedEndpoints.length > 0) {
      sdkConfig.priceFeedEndpoints = this.config.priceFeedEndpoints;
      console.log("Using user specified price feed endpoints", sdkConfig.priceFeedEndpoints);
    } else {
      console.warn(
        "No price feed endpoints specified in config. Using default endpoints from SDK.",
        sdkConfig.priceFeedEndpoints
      );
    }
    this.bots = this.privateKey.map((pk) => ({
      api: new LiquidatorTool(sdkConfig, pk),
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
        this.bots.map((liq) => liq.api.createProxyInstance(this.providers[i]))
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
    });
    console.log("initialized");
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

  private async liquidateTraderByBot(botIdx: number, symbol: string, trader: string) {
    trader = trader.toLowerCase();
    if (this.bots[botIdx].busy || this.locked.has(`${symbol}:${trader}`)) {
      return false;
    }
    // lock
    this.bots[botIdx].busy = true;
    this.locked.add(`${symbol}:${trader}`);

    // check if order is on-chain - stop if not/unable to check
    const isMarginSafe = await this.bots[botIdx].api.isMaintenanceMarginSafe(symbol, trader).catch(() => true);

    if (isMarginSafe) {
      console.log({
        info: "trader is margin safe",
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
      });
      this.bots[botIdx].busy = false;
      this.locked.delete(`${symbol}:${trader}`);
      return false;
    }

    // submit txn
    console.log({
      info: "submitting txn...",
      symbol: symbol,
      executor: this.bots[botIdx].api.getAddress(),
      trader: trader,
    });
    let tx: TransactionResponse;
    try {
      this.metrics.incrTxSubmissions();
      tx = await this.bots[botIdx].api.liquidateTrader(symbol, trader, this.config.rewardsAddress, undefined, {
        gasLimit: this.config.gasLimit,
      });
    } catch (e: any) {
      console.log({
        info: "txn rejected",
        reason: e.toString(),
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
      });
      this.metrics.incrTxRejects();
      this.bots[botIdx].busy = false;
      this.locked.delete(`${symbol}:${trader}`);
      return false;
    }
    console.log({
      info: "txn accepted",
      symbol: symbol,
      orderBook: tx.to,
      executor: tx.from,
      trader: trader,
      gasLimit: `${formatUnits(tx.gasLimit, "wei")} wei`,
      hash: tx.hash,
    });

    // confirm execution
    try {
      const receipt = await tx.wait();
      if (receipt === null) {
        throw new Error("tx confirmation receipt is null");
      }
      this.metrics.incrTxConfirmations();
      console.log({
        info: "txn confirmed",
        symbol: symbol,
        orderBook: receipt.to,
        executor: receipt.from,
        trader: trader,
        block: receipt.blockNumber,
        gasUsed: `${formatUnits(receipt.cumulativeGasUsed, "wei")} wei`,
        hash: receipt.hash,
      });
      this.locked.delete(`${symbol}:${trader}`);
    } catch (e: any) {
      let error = e?.toString() || "";
      this.metrics.incrTxFailures();
      console.log({
        info: "txn reverted",
        reason: error,
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
      });
      this.locked.delete(`${symbol}:${trader}`);
      const bot = this.bots[botIdx].api.getAddress();
      if (error.includes("insufficient funds for intrinsic transaction cost")) {
        try {
          await this.fundWallets([bot]);
        } catch (e: any) {
          console.log(`failed to fund bot ${bot}`);
        }
      }
    }
    // unlock bot
    this.bots[botIdx].busy = false;
    return true;
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

    const executed: Promise<boolean>[] = [];
    for (const msg of q) {
      const { symbol, traderAddr }: LiquidateTraderMsg = JSON.parse(msg);
      for (let i = 0; i < this.bots.length; i++) {
        const liq = this.bots[i];
        if (!liq.busy) {
          // msg will be attempted by this liquidator
          attempts++;
          this.q.delete(msg);
          executed.push(this.liquidateTraderByBot(i, symbol, traderAddr));
        }
      }
    }
    // send txns
    const results = await Promise.allSettled(executed);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        successes += result.value ? 1 : 0;
      } else {
        console.log(`uncaught error: ${result.reason.toString()}`);
      }
    }

    // return cases:
    if (successes == 0 && attempts == this.bots.length) {
      // all bots are down, either rpc or px service issue
      return BotStatus.Error;
    } else if (attempts == 0 && q.length > 0) {
      // did not try anything
      return BotStatus.Busy;
    } else if (successes == 0 && attempts > 0) {
      // tried something but it didn't work
      return BotStatus.PartialError;
    } else if (successes < attempts) {
      // some attempts worked, others failed
      return BotStatus.PartialError;
    } else {
      // everything worked or nothing happend
      return BotStatus.Ready;
    }
  }

  public async fundWallets(addressArray: string[]) {
    const provider = this.providers[Math.floor(Math.random() * this.providers.length)];
    const treasury = new Wallet(this.treasury, provider);
    const { gasPrice: gasPriceWei } = await provider.getFeeData();
    // min balance should cover 1e7 gas
    const minBalance = gasPriceWei! * BigInt(this.config.gasLimit * 5);
    for (let addr of addressArray) {
      const botBalance = await provider.getBalance(addr);
      const treasuryBalance = await provider.getBalance(treasury.address);
      console.log({
        treasuryAddr: treasury.address,
        treasuryBalance: formatUnits(treasuryBalance),
        botAddress: addr,
        botBalance: formatUnits(botBalance),
        minBalance: formatUnits(minBalance),
        needsFunding: botBalance < minBalance,
      });
      if (botBalance < minBalance) {
        // transfer twice the min so it doesn't transfer every time
        const transferAmount = minBalance * BigInt(2) - botBalance;
        if (transferAmount < treasuryBalance) {
          console.log({
            info: "transferring funds...",
            to: addr,
            transferAmount: formatUnits(transferAmount),
          });
          const tx = await treasury.sendTransaction({
            to: addr,
            value: transferAmount,
          });
          await tx.wait();
          console.log({
            transferAmount: formatUnits(transferAmount),
            txn: tx.hash,
          });
        } else {
          this.metrics.incFundingFailure();
          throw new Error(
            `insufficient balance in treasury (${formatUnits(treasuryBalance)}); send at least ${formatUnits(
              transferAmount
            )} to ${treasury.address}`
          );
        }
      }
    }
  }
}
