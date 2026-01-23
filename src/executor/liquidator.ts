import { LiquidatorTool, PerpetualDataHandler } from "@d8-x/d8x-node-sdk";
import { Network, Provider, TransactionResponse, Wallet, formatUnits } from "ethers";
import { Redis } from "ioredis";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider.js";
import { BotStatus, LiquidateTraderMsg, LiquidatorConfig } from "../types.js";
import { constructRedis, sleep } from "../utils.js";
import { Metrics } from "./metrics.js";

// Liquidation result status
export enum LiquidationStatus {
  NoOp,
  Success,
  Failure,
  Rejection,
}

export default class Liquidator {
  // objects
  private providers: MultiUrlJsonRpcProvider[];
  private bots: { api: LiquidatorTool; busy: boolean }[];
  private redisSubClient: Redis;
  private redisPubClient: Redis;

  // parameters
  private treasury: string;
  private privateKey: string[];
  private config: LiquidatorConfig;
  private earnings: string | undefined;
  private chainId: number;
  private gasPriceBuffer = 100n; // no buffer
  private lastUsedRpcIndex: number = 0;

  // state
  private q: Set<string> = new Set();
  private lastLiquidateCall: number = 0;
  // Set of symbol:traderAddr elements which are currently being processed.
  private locked: Set<string> = new Set();
  private timesTried: Map<string, number> = new Map();

  protected metrics: Metrics;

  constructor(pkTreasury: string, pkLiquidators: string[], config: LiquidatorConfig) {
    this.metrics = new Metrics();
    this.metrics.start();

    this.treasury = pkTreasury;
    this.privateKey = pkLiquidators;
    this.config = config;

    this.redisSubClient = constructRedis("executorSubClient");
    this.redisPubClient = constructRedis("executorPubClient");

    const sdkConfig = PerpetualDataHandler.readSDKConfig(this.config.sdkConfig);
    this.chainId = sdkConfig.chainId;
    this.providers = [
      new MultiUrlJsonRpcProvider(this.config.rpcExec, new Network(sdkConfig.name || "", sdkConfig.chainId), {
        timeoutSeconds: 25,
        logErrors: true,
        logRpcSwitches: true,
        staticNetwork: true,
        maxRetries: this.config.rpcExec.length * 3,
        // do not switch rpc on each request with premium rpcExec rpcs.
        switchRpcOnEachRequest: false,
      }),
    ];

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

    if (this.config.gasPriceMultiplier) {
      if (this.config.gasPriceMultiplier > 0) {
        // we only keep 2 digits
        this.gasPriceBuffer = BigInt(Math.round(this.config.gasPriceMultiplier * 100));
      } else {
        throw new Error("Invalid gas price buffer");
      }
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
        this.bots.map((liq) => liq.api.createProxyInstance(this.providers[i]), this)
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
            const { chainId } = JSON.parse(msg);
            if (this.chainId == chainId) {
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
      return LiquidationStatus.NoOp;
    }
    // lock
    const id = `${symbol}:${trader}`;
    this.bots[botIdx].busy = true;
    this.locked.add(id);
    this.timesTried.set(id, (this.timesTried.get(id) ?? 0) + 1);

    // Check if trader is margin safe before liquidating.
    let isMarginSafe = await this.bots[botIdx].api.isMaintenanceMarginSafe(symbol, trader).catch((e) => {
      console.log(e);
      return undefined;
    });

    // Do not liquidate when margin safe.
    if (isMarginSafe) {
      if (this.timesTried.get(id)! > 10) {
        throw new Error("too many false positives");
      }
      console.log({
        info: "trader is margin safe",
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
        timestamp: new Date().toISOString(),
      });
      this.bots[botIdx].busy = false;
      this.locked.delete(`${symbol}:${trader}`);
      return LiquidationStatus.NoOp;
    }

    // submit txn
    console.log({
      info: "submitting txn...",
      symbol: symbol,
      executor: this.bots[botIdx].api.getAddress(),
      trader: trader,
      timestamp: new Date().toISOString(),
    });
    let tx: TransactionResponse;
    try {
      this.metrics.incrTxSubmissions();
      const p = this.getNextRpc();
      const feeData = await this.getFeeData(p);
      tx = await this.bots[botIdx].api.liquidateTrader(symbol, trader, this.config.rewardsAddress, undefined, {
        ...feeData,
        rpcURL: p._getConnection().url,
      });
    } catch (e: any) {
      console.log({
        info: "txn rejected",
        reason: e.toString(),
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
        timestamp: new Date().toISOString(),
      });
      this.metrics.incrTxRejects();
      this.bots[botIdx].busy = false;
      if (isMarginSafe === undefined) {
        // tried without knowing and failed - keep locked
        await sleep(60);
      }
      this.locked.delete(`${symbol}:${trader}`);
      return LiquidationStatus.Rejection;
    }
    console.log({
      info: "txn accepted",
      symbol: symbol,
      orderBook: tx.to,
      executor: tx.from,
      trader: trader,
      gasLimit: tx.gasLimit ? `${formatUnits(tx.gasLimit, "wei")} gas` : undefined,
      gasPrice: tx.gasPrice ? `${formatUnits(tx.gasPrice)} wei` : undefined,
      maxFeePerGas: tx.maxFeePerGas ? `${formatUnits(tx.maxFeePerGas)} wei` : undefined,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? `${formatUnits(tx.maxPriorityFeePerGas)} wei` : undefined,
      hash: tx.hash,
      timestamp: new Date().toISOString(),
    });

    // confirm execution
    let result = LiquidationStatus.Success;
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
        timestamp: new Date().toISOString(),
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
        timestamp: new Date().toISOString(),
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
      if (this.timesTried.get(id)! > 10) {
        // too many failures for same account
        this.redisPubClient.publish("Restart", "too many trials");
        throw e;
      }
      // Set result to failure
      result = LiquidationStatus.Failure;
    }

    // unlock bot
    this.bots[botIdx].busy = false;
    return result;
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
    const q = [...this.q];

    if (q.length == 0) {
      return BotStatus.Ready;
    }

    const executed: Promise<LiquidationStatus>[] = [];
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

    let successes = 0;
    let noops = 0;

    // send txns
    const results = await Promise.allSettled(executed);
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        switch (result.value) {
          case LiquidationStatus.NoOp:
            noops++;
            break;
          case LiquidationStatus.Success:
            successes++;
            break;
          case LiquidationStatus.Failure:
          case LiquidationStatus.Rejection:
            // do nothing atm
            break;
        }
      } else {
        console.log({
          error: `uncaught error: ${result.reason.toString()}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // return cases:
    switch (true) {
      case noops === 0 && successes === 0 && attempts === this.bots.length:
        // failures/rejections only - all bots are down, either rpc or px
        // service issue
        return BotStatus.Error;
      case attempts == 0 && q.length > 0:
        // did not try anything
        return BotStatus.Busy;
      case successes == 0 && attempts > 0:
        // tried something but it didn't work
        return BotStatus.PartialError;
      case successes < attempts:
        // some attempts worked, others failed
        return BotStatus.PartialError;
      default:
        // everything worked or nothing happend
        return BotStatus.Ready;
    }
  }

  public async getFeeData(p: Provider) {
    return await p.getFeeData().then(({ gasPrice, maxFeePerGas, maxPriorityFeePerGas }) => {
      if (maxFeePerGas) {
        return {
          gasPrice: null,
          maxFeePerGas: (maxFeePerGas * this.gasPriceBuffer) / 100n,
          maxPriorityFeePerGas: ((maxPriorityFeePerGas ?? maxFeePerGas) * this.gasPriceBuffer) / 100n,
        };
      } else {
        return {
          gasPrice,
          maxFeePerGas: null,
          maxPriorityFeePerGas: null,
        };
      }
    });
  }

  // Returns next rpc provider in the list
  public getNextRpc() {
    this.lastUsedRpcIndex = (this.lastUsedRpcIndex + 1) % this.providers.length;
    return this.providers[this.lastUsedRpcIndex];
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
