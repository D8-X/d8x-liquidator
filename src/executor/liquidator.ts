import { LiquidatorTool, MarketData, NodeSDKConfig, PerpetualDataHandler } from "@d8-x/d8x-node-sdk";
import {
  type FeeData,
  Network,
  type Provider,
  type TransactionReceipt,
  type TransactionResponse,
  Wallet,
  formatUnits,
} from "ethers";
import { Redis } from "ioredis";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider.js";
import { initLiquidatorsFromMarketData, initMarketDataWithCache } from "../sdkInit.js";
import { loadSDKState, sdkStateUpdatedChannel } from "../sdkState.js";
import { BotStatus, LiquidateTraderMsg, LiquidatorConfig } from "../types.js";
import { PerpStates } from "../watchlist.js";
import { constructRedis, errCode, errMsg, executeWithTimeout, sleep } from "../utils.js";
import { loadWatchlist, parsePerpStates, watchlistChannel } from "../watchlist.js";
import { categorizeFailReason, categorizeRejectReason, Metrics } from "./metrics.js";
import { createLogger } from "../logger.js";

const log = createLogger("liquidator");

// Liquidation result status
export enum LiquidationStatus {
  NoOp,
  Success,
  Failure,
  Rejection,
}

interface Bot {
  api: LiquidatorTool;
  busy: boolean;
}

interface TxFeeOverrides {
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
}

export default class Liquidator {
  // objects
  private providers: MultiUrlJsonRpcProvider[];
  private bots: Bot[];
  private redisSubClient: Redis;
  private redisPubClient: Redis;
  private md!: MarketData;

  // parameters
  private treasury: string;
  private privateKey: string[];
  private config: LiquidatorConfig;
  private chainId: number;
  private sdkConfig: NodeSDKConfig;
  private gasPriceBuffer: bigint = 100n; // no buffer
  private lastUsedRpcIndex: number = 0;
  private fundingInProgress: boolean = false;
  private refreshingSDK: boolean = false;

  // state
  private q: Set<string> = new Set<string>();
  private lastLiquidateCall: number = 0;
  // Set of symbol:traderAddr elements which are currently being processed.
  private locked: Set<string> = new Set<string>();
  private timesTried: Map<string, number> = new Map<string, number>();
  private allowedSymbols: Set<string> | null = null;
  private botBalances: Map<string, bigint> = new Map<string, bigint>();

  protected metrics: Metrics;

  constructor(pkTreasury: string, pkLiquidators: string[], config: LiquidatorConfig) {
    this.metrics = new Metrics(config.sdkConfig);
    this.metrics.start();

    this.treasury = pkTreasury;
    this.privateKey = pkLiquidators;
    this.config = config;

    this.redisSubClient = constructRedis("executorSubClient");
    this.redisPubClient = constructRedis("executorPubClient");

    const sdkConfig: NodeSDKConfig = PerpetualDataHandler.readSDKConfig(this.config.sdkConfig);
    this.sdkConfig = sdkConfig;
    this.chainId = sdkConfig.chainId;
    this.providers = [
      new MultiUrlJsonRpcProvider(this.config.rpcExec, new Network(sdkConfig.name ?? "", sdkConfig.chainId), {
        timeoutSeconds: 25,
        logErrors: true,
        logRpcSwitches: true,
        staticNetwork: true,
        maxRetries: this.config.rpcExec.length * 3,
        switchRpcOnEachRequest: this.config.switchRpcOnEachRequest ?? false,
      }),
    ];

    // Use price feed endpoints from user specified config
    if (this.config.priceFeedEndpoints.length > 0) {
      sdkConfig.priceFeedEndpoints = this.config.priceFeedEndpoints;
      log.info({ priceFeedEndpoints: sdkConfig.priceFeedEndpoints }, "Using user specified price feed endpoints");
    } else {
      log.warn(
        { priceFeedEndpoints: sdkConfig.priceFeedEndpoints },
        "No price feed endpoints specified in config. Using default endpoints from SDK.",
      );
    }
    this.bots = this.privateKey.map(
      (pk: string): Bot => ({
        api: new LiquidatorTool(sdkConfig, pk),
        busy: false,
      }),
    );
    this.bots.forEach((bot: Bot, idx: number): void => {
      this.metrics.registerBot(idx, bot.api.getAddress());
    });
    this.metrics.setConfigInfo({
      gasLimit: this.config.gasLimit,
      gasPriceMultiplier: this.config.gasPriceMultiplier,
      bots: this.config.bots,
      liquidateIntervalSecondsMin: this.config.liquidateIntervalSecondsMin,
      liquidateIntervalSecondsMax: this.config.liquidateIntervalSecondsMax,
      fetchPricesIntervalSecondsMin: this.config.fetchPricesIntervalSecondsMin,
      checkIntervalSecondsMin: this.config.checkIntervalSecondsMin,
      checkIntervalSecondsMax: this.config.checkIntervalSecondsMax,
      liquidatableBatchSize: this.config.liquidatableBatchSize,
      priceMovePctThreshold: this.config.priceMovePctThreshold,
    });

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
  public async initialize(): Promise<void> {
    this.md = new MarketData(this.sdkConfig);
    const result = await initMarketDataWithCache(this.md, this.providers, this.redisPubClient);
    log.info(
      { cache: result.usedCache, cacheAgeMs: result.cacheAgeMs, providerIndex: result.providerIndex },
      "executor MarketData initialized",
    );
    await initLiquidatorsFromMarketData(this.bots, this.md, this.providers[result.providerIndex]);

    const initial: PerpStates | null = await loadWatchlist(this.redisPubClient, this.chainId);
    if (initial !== null) {
      this.allowedSymbols = new Set<string>(
        Object.keys(initial).filter((s: string): boolean => initial[s] === "NORMAL"),
      );
      log.info({ size: this.allowedSymbols.size }, "executor: loaded initial watchlist from redis");
    }

    // Subscribe to relayed events
    await this.redisSubClient.subscribe(
      "LiquidateTrader",
      sdkStateUpdatedChannel(this.chainId),
      watchlistChannel(this.chainId),
      (err: Error | null | undefined, _count: unknown): void => {
        if (err) {
          log.error({ err }, "redis subscription failed");
          process.exit(1);
        }
      },
    );

    // Periodic safety-net top-up; complements the rejection-driven path.
    setInterval((): void => {
      const addrs: string[] = this.bots.map((b: Bot): string => b.api.getAddress());
      this.fundWallets(addrs).catch((err: unknown): void => {
        log.warn({ err }, "periodic top-up failed");
      });
    }, 60 * 60 * 1_000).unref();

    // Periodic SDK refresh as a safety net. The primary refresh paths are
    // event-driven (sdk-state-updated channel) and lazy (force-RPC on
    // "No perpetual found" rejections). This catches the rare edge case
    // where neither fires — e.g. a Redis reconnect drops the subscription
    // while no liquidations are attempted on newly-registered perps.
    setInterval((): void => {
      this.refreshSDK().catch((err: unknown): void => {
        log.warn({ err }, "periodic refreshSDK failed");
      });
    }, 60 * 60 * 1_000).unref();

    log.info("initialized");
  }

  private async refreshSDK(opts?: { forceRpc?: boolean }): Promise<void> {
    if (this.refreshingSDK) return;
    this.refreshingSDK = true;
    try {
      for (let i = 0; i < 30 && this.bots.some((b: Bot): boolean => b.busy); i++) {
        await sleep(100);
      }
      const provider: MultiUrlJsonRpcProvider = this.providers[this.lastUsedRpcIndex] ?? this.providers[0];
      if (opts?.forceRpc) {
        // Wrap with timeout: a hung refreshSymbols (e.g. unresponsive RPC) would
        // leave refreshingSDK=true forever, blocking every liquidation.
        await executeWithTimeout(
          this.md.refreshSymbols(true),
          30_000,
          "refreshSymbols(true) timed out (forced RPC refresh)",
        );
        log.info("executor: SDK state refreshed via RPC (forced)");
      } else {
        const cached = await loadSDKState(this.redisPubClient, {
          chainId: this.chainId,
          proxyAddr: this.sdkConfig.proxyAddr,
        });
        if (cached) {
          await this.md.createProxyInstanceFromState(cached.state, provider);
          log.info({ cacheAgeMs: cached.ageMs }, "executor: SDK state reloaded from commander cache");
        } else {
          await executeWithTimeout(
            this.md.refreshSymbols(true),
            30_000,
            "refreshSymbols(true) timed out (no-cache RPC refresh)",
          );
          log.info("executor: SDK state refreshed via RPC (no cache)");
        }
      }
      await initLiquidatorsFromMarketData(this.bots, this.md, provider);
    } catch (e: unknown) {
      log.warn({ err: e }, "executor: refreshSDK failed");
    } finally {
      this.refreshingSDK = false;
    }
  }

  /**
   * Subscribes to liquidation opportunities and attempts to liquidate.
   */
  public run(): Promise<void> {
    return new Promise<void>((): void => {
      setInterval((): void => {
        if (Date.now() - this.lastLiquidateCall > this.config.liquidateIntervalSecondsMax) {
          void this.liquidate();
        }
      });

      const watchlistCh: string = watchlistChannel(this.chainId);
      const stateUpdCh: string = sdkStateUpdatedChannel(this.chainId);
      this.redisSubClient.on("message", (channel: string, msg: string): void => {
        void this.handleMessage(channel, msg, watchlistCh, stateUpdCh);
      });
    });
  }

  private async handleMessage(channel: string, msg: string, watchlistCh: string, stateUpdCh: string): Promise<void> {
    if (channel === watchlistCh) {
      const states: PerpStates | null = parsePerpStates(msg);
      if (states) {
        this.allowedSymbols = new Set<string>(
          Object.keys(states).filter((s: string): boolean => states[s] === "NORMAL"),
        );
      }
      return;
    }
    if (channel === stateUpdCh) {
      void this.refreshSDK();
      return;
    }
    if (channel === "LiquidateTrader") {
      const { chainId }: LiquidateTraderMsg = JSON.parse(msg) as LiquidateTraderMsg;
      if (this.chainId === chainId) {
        this.q.add(msg);
        const res: BotStatus = await this.liquidate();
        if (res === BotStatus.Error) {
          throw new Error("error");
        }
      }
    }
  }

  private async liquidateTraderByBot(botIdx: number, symbol: string, trader: string): Promise<LiquidationStatus> {
    trader = trader.toLowerCase();
    if (this.refreshingSDK || this.bots[botIdx].busy || this.locked.has(`${symbol}:${trader}`)) {
      return LiquidationStatus.NoOp;
    }
    if (!this.allowedSymbols?.has(symbol)) {
      log.warn(
        { symbol, trader },
        this.allowedSymbols === null
          ? "executor: skipping - watchlist not yet received"
          : "executor: skipping - not in watchlist",
      );
      return LiquidationStatus.NoOp;
    }
    const id: string = `${symbol}:${trader}`;
    this.bots[botIdx].busy = true;
    this.locked.add(id);
    this.timesTried.set(id, (this.timesTried.get(id) ?? 0) + 1);

    // submit txn
    log.info(
      {
        symbol: symbol,
        executor: this.bots[botIdx].api.getAddress(),
        trader: trader,
      },
      "submitting txn...",
    );
    let tx: TransactionResponse;
    try {
      const p: MultiUrlJsonRpcProvider = this.getNextRpc();
      const feeData: TxFeeOverrides = await this.getFeeData(p);
      // Wrap liquidateTrader with timeout to prevent hanging on slow price feeds or unresponsive RPCs
      tx = await executeWithTimeout(
        this.bots[botIdx].api.liquidateTrader(symbol, trader, this.config.rewardsAddress, undefined, {
          ...feeData,
          rpcURL: p._getConnection().url,
        }),
        30_000, // 30 second timeout
        `liquidateTrader timed out for ${symbol}:${trader}`,
      );
    } catch (e: unknown) {
      const reason: string = errMsg(e);
      log.error(
        {
          err: e,
          reason,
          symbol: symbol,
          executor: this.bots[botIdx].api.getAddress(),
          trader: trader,
        },
        "txn rejected",
      );
      this.metrics.incLiquidation(botIdx, symbol, "rejected", categorizeRejectReason(e));
      this.locked.delete(`${symbol}:${trader}`);
      if (errCode(e) === "INSUFFICIENT_FUNDS" || reason.includes("insufficient funds for intrinsic transaction cost")) {
        const bot: string = this.bots[botIdx].api.getAddress();
        try {
          await this.fundWallets([bot]);
        } catch (fundErr: unknown) {
          log.error({ err: fundErr, bot }, "failed to fund bot");
        }
      }
      if (reason.includes("No perpetual found for symbol")) {
        void this.refreshSDK({ forceRpc: true });
      }
      this.bots[botIdx].busy = false;
      return LiquidationStatus.Rejection;
    }
    log.info(
      {
        symbol: symbol,
        orderBook: tx.to,
        executor: tx.from,
        trader: trader,
        gasLimit: tx.gasLimit ? `${formatUnits(tx.gasLimit, "wei")} gas` : undefined,
        gasPrice: tx.gasPrice ? `${formatUnits(tx.gasPrice)} wei` : undefined,
        maxFeePerGas: tx.maxFeePerGas ? `${formatUnits(tx.maxFeePerGas)} wei` : undefined,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? `${formatUnits(tx.maxPriorityFeePerGas)} wei` : undefined,
        hash: tx.hash,
      },
      "txn accepted",
    );

    // confirm execution
    let result: LiquidationStatus = LiquidationStatus.Success;
    try {
      const receipt: TransactionReceipt | null = await tx.wait();
      if (receipt === null) {
        throw new Error("tx confirmation receipt is null");
      }
      if (receipt.status === 0) {
        throw new Error("tx reverted on-chain (status=0)");
      }
      this.metrics.observeLastLiquidation(botIdx, receipt.from);
      this.metrics.incLiquidation(botIdx, symbol, "confirmed", "ok");
      this.applyGasSpent(botIdx, receipt.from, receipt.gasUsed, receipt.gasPrice);
      log.info(
        {
          symbol: symbol,
          orderBook: receipt.to,
          executor: receipt.from,
          trader: trader,
          block: receipt.blockNumber,
          gasUsed: `${formatUnits(receipt.cumulativeGasUsed, "wei")} wei`,
          hash: receipt.hash,
        },
        "txn confirmed",
      );
      this.locked.delete(`${symbol}:${trader}`);
    } catch (e: unknown) {
      const error: string = errMsg(e);
      this.metrics.incLiquidation(botIdx, symbol, "failed", categorizeFailReason(e));
      log.error(
        {
          err: e,
          reason: error,
          symbol: symbol,
          executor: this.bots[botIdx].api.getAddress(),
          trader: trader,
        },
        "txn reverted",
      );
      this.locked.delete(`${symbol}:${trader}`);
      const bot: string = this.bots[botIdx].api.getAddress();
      if (error.includes("insufficient funds for intrinsic transaction cost")) {
        try {
          await this.fundWallets([bot]);
        } catch (innerErr: unknown) {
          log.error({ err: innerErr, bot }, "failed to fund bot");
        }
      }
      if ((this.timesTried.get(id) ?? 0) > 10) {
        // too many failures for same account
        void this.redisPubClient.publish("Restart", "too many trials");
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
  public async liquidate(): Promise<BotStatus> {
    if (Date.now() - this.lastLiquidateCall < this.config.liquidateIntervalSecondsMin * 1_000) {
      return BotStatus.Busy;
    }

    this.lastLiquidateCall = Date.now();
    let attempts: number = 0;
    const q: string[] = [...this.q];

    if (q.length === 0) {
      return BotStatus.Ready;
    }

    const executed: Promise<LiquidationStatus>[] = [];
    for (const msg of q) {
      const { symbol, traderAddr }: LiquidateTraderMsg = JSON.parse(msg) as LiquidateTraderMsg;
      for (let i = 0; i < this.bots.length; i++) {
        const liq: Bot = this.bots[i];
        if (!liq.busy) {
          attempts++;
          this.q.delete(msg);
          executed.push(this.liquidateTraderByBot(i, symbol, traderAddr));
          break;
        }
      }
    }

    let successes: number = 0;
    let noops: number = 0;

    // send txns
    const results: PromiseSettledResult<LiquidationStatus>[] = await Promise.allSettled(executed);
    for (const result of results) {
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
        log.error({ err: result.reason }, "uncaught error");
      }
    }

    // return cases:
    switch (true) {
      case noops === 0 && successes === 0 && attempts === this.bots.length:
        // failures/rejections only - all bots are down, either rpc or px
        // service issue
        return BotStatus.Error;
      case attempts === 0 && q.length > 0:
        // did not try anything
        return BotStatus.Busy;
      case successes === 0 && attempts > 0:
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

  public async getFeeData(p: Provider): Promise<TxFeeOverrides> {
    const { gasPrice, maxFeePerGas, maxPriorityFeePerGas }: FeeData = await p.getFeeData();
    if (maxFeePerGas !== null && maxFeePerGas > 0n) {
      return {
        gasPrice: null,
        maxFeePerGas: (maxFeePerGas * this.gasPriceBuffer) / 100n,
        maxPriorityFeePerGas: ((maxPriorityFeePerGas ?? maxFeePerGas) * this.gasPriceBuffer) / 100n,
      };
    }
    return {
      gasPrice,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    };
  }

  // Returns next rpc provider in the list
  public getNextRpc(): MultiUrlJsonRpcProvider {
    this.lastUsedRpcIndex = (this.lastUsedRpcIndex + 1) % this.providers.length;
    return this.providers[this.lastUsedRpcIndex];
  }

  public async fundWallets(addressArray: string[]): Promise<void> {
    if (this.fundingInProgress) {
      log.info({ size: addressArray.length }, "skipping fundWallets - already in progress");
      return;
    }
    this.fundingInProgress = true;
    try {
      await this.doFundWallets(addressArray);
    } finally {
      this.fundingInProgress = false;
    }
  }

  private async doFundWallets(addressArray: string[]): Promise<void> {
    const provider: MultiUrlJsonRpcProvider = this.providers[Math.floor(Math.random() * this.providers.length)];
    const treasury: Wallet = new Wallet(this.treasury, provider);
    const { gasPrice: gasPriceWei } = await provider.getFeeData();
    if (gasPriceWei === null) {
      throw new Error("provider did not return a gas price");
    }
    // min balance should cover 1e7 gas
    const minBalance: bigint = gasPriceWei * BigInt(this.config.gasLimit * 5);
    this.metrics.setMinBalance(Number(formatUnits(minBalance, 18)));
    for (const addr of addressArray) {
      const botBalance: bigint = await provider.getBalance(addr);
      const treasuryBalance: bigint = await provider.getBalance(treasury.address);
      this.metrics.setTreasuryBalance(treasury.address, Number(formatUnits(treasuryBalance, 18)));
      const botIdx: number = this.botIdxFromAddress(addr);
      if (botIdx >= 0) {
        this.botBalances.set(addr.toLowerCase(), botBalance);
        this.metrics.setBotBalance(botIdx, addr, Number(formatUnits(botBalance, 18)));
      }
      log.info({
        treasuryAddr: treasury.address,
        treasuryBalance: formatUnits(treasuryBalance),
        botAddress: addr,
        botBalance: formatUnits(botBalance),
        minBalance: formatUnits(minBalance),
        needsFunding: botBalance < minBalance,
      });
      if (botBalance < minBalance) {
        // top up many minBalances so we don't transfer every time
        const fullTopUp: bigint = minBalance * BigInt(100) - botBalance;
        // If treasury can't afford the full top-up, fall back to a fair share
        // (treasuryBalance / total bots) so a single bot doesn't drain the
        // treasury and starve the others.
        const fairShare: bigint = treasuryBalance / BigInt(this.bots.length);
        let transferAmount: bigint;
        if (fullTopUp < treasuryBalance) {
          transferAmount = fullTopUp;
        } else if (fairShare > 0n) {
          if (botIdx >= 0) {
            this.metrics.incFundingFailure(botIdx, addr, "treasury_partial");
          }
          log.warn(
            {
              treasuryBalance: formatUnits(treasuryBalance),
              wanted: formatUnits(fullTopUp),
              fairShare: formatUnits(fairShare),
              numBots: this.bots.length,
            },
            "treasury insufficient for full top-up; using fair-share fallback",
          );
          transferAmount = fairShare;
        } else {
          if (botIdx >= 0) {
            this.metrics.incFundingFailure(botIdx, addr, "treasury_insufficient");
          }
          throw new Error(`treasury empty (${formatUnits(treasuryBalance)}); send funds to ${treasury.address}`);
        }
        log.info(
          {
            to: addr,
            transferAmount: formatUnits(transferAmount),
          },
          "transferring funds...",
        );
        const tx: TransactionResponse = await treasury.sendTransaction({
          to: addr,
          value: transferAmount,
        });
        await tx.wait();
        if (botIdx >= 0) {
          const newBalance: bigint = botBalance + transferAmount;
          this.botBalances.set(addr.toLowerCase(), newBalance);
          this.metrics.setBotBalance(botIdx, addr, Number(formatUnits(newBalance, 18)));
        }
        log.info({
          transferAmount: formatUnits(transferAmount),
          txn: tx.hash,
        });
      }
    }
  }

  private botIdxFromAddress(addr: string): number {
    const target: string = addr.toLowerCase();
    return this.bots.findIndex((b: Bot): boolean => b.api.getAddress().toLowerCase() === target);
  }

  private applyGasSpent(botIdx: number, botAddr: string, gasUsed: bigint, gasPrice: bigint): void {
    const key: string = botAddr.toLowerCase();
    const cost: bigint = gasUsed * gasPrice;
    this.metrics.incGasSpentWei(botIdx, cost);
    const cached: bigint | undefined = this.botBalances.get(key);
    if (cached === undefined) return;
    const next: bigint = cost > cached ? 0n : cached - cost;
    this.botBalances.set(key, next);
    this.metrics.setBotBalance(botIdx, botAddr, Number(formatUnits(next, 18)));
  }
}
