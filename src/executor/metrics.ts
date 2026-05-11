import * as promClient from "prom-client";
import express, { type Request, type Response } from "express";
import { createLogger } from "../logger.js";
import { errMsg } from "../utils.js";
import { FundingFailureReason, LiquidationOutcome, Reason, RejectReason, FailReason } from "./metricsTypes.js";

const log = createLogger("executor.metrics");

export { LiquidationOutcome, RejectReason, FailReason, FundingFailureReason, Reason } from "./metricsTypes.js";

export function categorizeRejectReason(err: unknown): RejectReason {
  const msg: string = errMsg(err).toLowerCase();
  if (msg.includes("insufficient funds")) return "insufficient_funds";
  if (msg.includes("gas price too low") || msg.includes("fee too low")) return "gas_price_too_low";
  if (msg.includes("intrinsic gas")) return "intrinsic_gas";
  if (msg.includes("timed out") || msg.includes("timeout")) return "submit_timeout";
  if (msg.includes("margin safe") || msg.includes("not unsafe")) return "margin_safe_at_estimate";
  if (msg.includes("pyth") || msg.includes("odin") || msg.includes("price feed") || msg.includes("stale")) {
    return "price_feed_unavailable";
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("server response")
  ) {
    return "rpc_error";
  }
  return "other";
}

export function categorizeFailReason(err: unknown): FailReason {
  const msg: string = errMsg(err).toLowerCase();
  if (msg.includes("receipt is null") || msg.includes("dropped")) return "tx_dropped";
  if (msg.includes("timed out") || msg.includes("timeout")) return "wait_timeout";
  if (msg.includes("margin safe") || msg.includes("not unsafe")) return "margin_safe_at_mine";
  if (msg.includes("already liquidated") || msg.includes("trader liquidated") || msg.includes("no position")) {
    return "already_liquidated";
  }
  if (msg.includes("market closed") || msg.includes("perp paused") || msg.includes("paused")) {
    return "market_closed";
  }
  if (msg.includes("oracle")) return "oracle_stale";
  if (msg.includes("revert") || msg.includes("call_exception")) return "other_revert";
  return "wait_other";
}

export class Metrics {
  private readonly chain: string;

  constructor(
    chain: string = process.env.SDK_CONFIG ?? "unknown",
    // Port on which metrics endpoint server will be exposed
    private port: number = parseInt(process.env.METRICS_PORT ?? "9001", 10),
    // Endpoint on which the metrics will be exposed
    private endpoint: string = "metrics",

    // All the exported metrics below
    private metricsList = {
      liquidationsTotal: new promClient.Counter({
        name: "liquidator_liquidations_total",
        help: "Cumulative count of liquidation outcomes, by perpetual symbol, reason and worker wallet.",
        labelNames: ["chain", "bot_idx", "symbol", "outcome", "reason"] as const,
      }),
      lastLiquidationTimestamp: new promClient.Gauge({
        name: "liquidator_last_liquidation_timestamp_seconds",
        help: "Unix timestamp of the last successful liquidation per worker wallet.",
        labelNames: ["chain", "bot_idx", "bot_addr"] as const,
      }),
      botBalance: new promClient.Gauge({
        name: "liquidator_bot_balance_eth",
        help: "Native-token balance of the worker wallet, in ETH.",
        labelNames: ["chain", "bot_idx", "bot_addr"] as const,
      }),
      fundingFailures: new promClient.Counter({
        name: "liquidator_funding_failures_total",
        help: "Cumulative count of treasury-to-bot funding failures, by reason.",
        labelNames: ["chain", "bot_idx", "bot_addr", "reason"] as const,
      }),
      botInfo: new promClient.Gauge({
        name: "liquidator_bot_info",
        help: "Static bot identity gauge, value is always 1. One series per worker wallet.",
        labelNames: ["chain", "bot_idx", "bot_addr"] as const,
      }),
      minBalance: new promClient.Gauge({
        name: "liquidator_min_balance_eth",
        help: "Minimum native-token balance required for a bot to operate, computed as gasPrice * gasLimit * 5.",
        labelNames: ["chain"] as const,
      }),
      treasuryBalance: new promClient.Gauge({
        name: "liquidator_treasury_balance_eth",
        help: "Native-token balance of the treasury wallet (HD index 0), in ETH.",
        labelNames: ["chain", "treasury_addr"] as const,
      }),
      gasSpentWei: new promClient.Counter({
        name: "liquidator_gas_spent_wei_total",
        help: "Cumulative gas spent (wei) by each bot wallet on confirmed transactions. Daily = increase(...[1d]).",
        labelNames: ["chain", "bot_idx"] as const,
      }),
      configGasLimit: new promClient.Gauge({
        name: "liquidator_config_gas_limit",
        help: "Configured gasLimit for liquidation transactions.",
        labelNames: ["chain"] as const,
      }),
      configGasPriceMultiplier: new promClient.Gauge({
        name: "liquidator_config_gas_price_multiplier",
        help: "Multiplier applied to current gas price when sending transactions.",
        labelNames: ["chain"] as const,
      }),
      configBots: new promClient.Gauge({
        name: "liquidator_config_bots",
        help: "Configured number of liquidator bot wallets.",
        labelNames: ["chain"] as const,
      }),
      configLiquidateIntervalSecondsMin: new promClient.Gauge({
        name: "liquidator_config_liquidate_interval_seconds_min",
        help: "Minimum delay between liquidation attempts for the same trader.",
        labelNames: ["chain"] as const,
      }),
      configLiquidateIntervalSecondsMax: new promClient.Gauge({
        name: "liquidator_config_liquidate_interval_seconds_max",
        help: "Maximum delay between liquidation attempts for the same trader.",
        labelNames: ["chain"] as const,
      }),
      configFetchPricesIntervalSecondsMin: new promClient.Gauge({
        name: "liquidator_config_fetch_prices_interval_seconds_min",
        help: "Minimum interval between off-chain price fetches.",
        labelNames: ["chain"] as const,
      }),
      configCheckIntervalSecondsMin: new promClient.Gauge({
        name: "liquidator_config_check_interval_seconds_min",
        help: "Minimum interval between commander pool checks.",
        labelNames: ["chain"] as const,
      }),
      configCheckIntervalSecondsMax: new promClient.Gauge({
        name: "liquidator_config_check_interval_seconds_max",
        help: "Maximum interval between commander pool checks.",
        labelNames: ["chain"] as const,
      }),
      configLiquidatableBatchSize: new promClient.Gauge({
        name: "liquidator_config_liquidatable_batch_size",
        help: "Max perps queried per Multicall in getLiquidatableAccountsInPool.",
        labelNames: ["chain"] as const,
      }),
      configPriceMovePctThreshold: new promClient.Gauge({
        name: "liquidator_config_price_move_pct_threshold",
        help: "Spot price move (fraction) that triggers an early pool re-check.",
        labelNames: ["chain"] as const,
      }),
    },
  ) {
    this.chain = chain;
  }

  /**
   * Start the metrics endpoint
   */
  public start(): void {
    this.metricsEndpoint(this.port, this.endpoint);
  }

  /**
   * Exposes metrics endpoint at given port
   * @param port
   */
  private metricsEndpoint(port: number, endpoint: string = "metrics"): void {
    const app: express.Express = express();
    app.get(`/${endpoint}`, (_req: Request, res: Response): void => {
      promClient.register
        .metrics()
        .then((m: string): void => {
          res.set("Content-Type", promClient.register.contentType);
          res.end(m);
        })
        .catch((err: unknown): void => {
          log.error({ err }, "metrics endpoint failed");
          res.status(500).end();
        });
    });
    log.info({ port, endpoint, url: `http://localhost:${port}/${endpoint}` }, "Starting metrics endpoint");
    app.listen(port);
  }

  public incLiquidation(symbol: string, outcome: LiquidationOutcome, reason: Reason, n: number = 1): void {
  public incLiquidation(botIdx: number, symbol: string, outcome: LiquidationOutcome, reason: Reason, n: number = 1) {
    if (n <= 0) return;
    this.metricsList.liquidationsTotal.labels(this.chain, String(botIdx), symbol, outcome, reason).inc(n);
  }

  public incGasSpentWei(botIdx: number, wei: bigint) {
    if (wei <= 0n) return;
    this.metricsList.gasSpentWei.labels(this.chain, String(botIdx)).inc(Number(wei));
  }

  public observeLastLiquidation(botIdx: number, botAddr: string, when: Date = new Date()): void {
    this.metricsList.lastLiquidationTimestamp
      .labels(this.chain, String(botIdx), botAddr.toLowerCase())
      .set(Math.floor(when.getTime() / 1000));
  }

  public setBotBalance(botIdx: number, botAddr: string, eth: number): void {
    this.metricsList.botBalance.labels(this.chain, String(botIdx), botAddr.toLowerCase()).set(eth);
  }

  public incFundingFailure(botIdx: number, botAddr: string, reason: FundingFailureReason, n: number = 1): void {
    if (n <= 0) return;
    this.metricsList.fundingFailures.labels(this.chain, String(botIdx), botAddr.toLowerCase(), reason).inc(n);
  }

  public registerBot(botIdx: number, botAddr: string): void {
    this.metricsList.botInfo.labels(this.chain, String(botIdx), botAddr.toLowerCase()).set(1);
  }

  public setMinBalance(eth: number): void {
    this.metricsList.minBalance.labels(this.chain).set(eth);
  }

  public setTreasuryBalance(addr: string, eth: number) {
    this.metricsList.treasuryBalance.labels(this.chain, addr.toLowerCase()).set(eth);
  }

  public setConfigInfo(cfg: {
    gasLimit: number;
    gasPriceMultiplier: number;
    bots: number;
    liquidateIntervalSecondsMin: number;
    liquidateIntervalSecondsMax: number;
    fetchPricesIntervalSecondsMin: number;
    checkIntervalSecondsMin?: number;
    checkIntervalSecondsMax?: number;
    liquidatableBatchSize?: number;
    priceMovePctThreshold?: number;
  }) {
    this.metricsList.configGasLimit.labels(this.chain).set(cfg.gasLimit);
    this.metricsList.configGasPriceMultiplier.labels(this.chain).set(cfg.gasPriceMultiplier);
    this.metricsList.configBots.labels(this.chain).set(cfg.bots);
    this.metricsList.configLiquidateIntervalSecondsMin.labels(this.chain).set(cfg.liquidateIntervalSecondsMin);
    this.metricsList.configLiquidateIntervalSecondsMax.labels(this.chain).set(cfg.liquidateIntervalSecondsMax);
    this.metricsList.configFetchPricesIntervalSecondsMin.labels(this.chain).set(cfg.fetchPricesIntervalSecondsMin);
    if (cfg.checkIntervalSecondsMin !== undefined)
      this.metricsList.configCheckIntervalSecondsMin.labels(this.chain).set(cfg.checkIntervalSecondsMin);
    if (cfg.checkIntervalSecondsMax !== undefined)
      this.metricsList.configCheckIntervalSecondsMax.labels(this.chain).set(cfg.checkIntervalSecondsMax);
    if (cfg.liquidatableBatchSize !== undefined)
      this.metricsList.configLiquidatableBatchSize.labels(this.chain).set(cfg.liquidatableBatchSize);
    if (cfg.priceMovePctThreshold !== undefined)
      this.metricsList.configPriceMovePctThreshold.labels(this.chain).set(cfg.priceMovePctThreshold);
  }
}
