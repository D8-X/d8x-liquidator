import * as promClient from "prom-client";
import express from "express";
import { createLogger } from "../logger.js";
import {
  FundingFailureReason,
  LiquidationOutcome,
  Reason,
  RejectReason,
  FailReason,
} from "./metricsTypes.js";

const log = createLogger("executor.metrics");

export {
  LiquidationOutcome,
  RejectReason,
  FailReason,
  FundingFailureReason,
  Reason,
} from "./metricsTypes.js";

export function categorizeRejectReason(err: unknown): RejectReason {
  const msg = String(err ?? "").toLowerCase();
  if (msg.includes("insufficient funds")) return "insufficient_funds";
  if (msg.includes("gas price too low") || msg.includes("fee too low")) return "gas_price_too_low";
  if (msg.includes("intrinsic gas")) return "intrinsic_gas";
  if (msg.includes("timed out") || msg.includes("timeout")) return "submit_timeout";
  if (msg.includes("margin safe") || msg.includes("not unsafe")) return "margin_safe_at_estimate";
  if (
    msg.includes("pyth") ||
    msg.includes("odin") ||
    msg.includes("price feed") ||
    msg.includes("stale")
  ) {
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
  const msg = String(err ?? "").toLowerCase();
  if (msg.includes("null receipt") || msg.includes("dropped")) return "tx_dropped";
  if (msg.includes("timed out") || msg.includes("timeout")) return "wait_timeout";
  if (msg.includes("margin safe") || msg.includes("not unsafe")) return "margin_safe_at_mine";
  if (
    msg.includes("already liquidated") ||
    msg.includes("trader liquidated") ||
    msg.includes("no position")
  ) {
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
        help: "Cumulative count of liquidation outcomes, by perpetual symbol and reason.",
        labelNames: ["chain", "symbol", "outcome", "reason"] as const,
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
    }
  ) {
    this.chain = chain;
  }

  /**
   * Start the metrics endpoint
   */
  public async start() {
    this.metricsEndpoint(this.port, this.endpoint);
  }

  /**
   * Exposes metrics endpoint at given port
   * @param port
   */
  private async metricsEndpoint(port: number, endpoint: string = "metrics") {
    const app = express();
    app.get(`/${endpoint}`, async (_req: any, res: any) => {
      res.set("Content-Type", promClient.register.contentType);
      res.end(await promClient.register.metrics());
    });
    log.info({ port, endpoint, url: `http://localhost:${port}/${endpoint}` }, "Starting metrics endpoint");
    app.listen(port);
  }

  public incLiquidation(symbol: string, outcome: LiquidationOutcome, reason: Reason, n: number = 1) {
    if (n <= 0) return;
    this.metricsList.liquidationsTotal
      .labels(this.chain, symbol, outcome, reason)
      .inc(n);
  }

  public observeLastLiquidation(botIdx: number, botAddr: string, when: Date = new Date()) {
    this.metricsList.lastLiquidationTimestamp
      .labels(this.chain, String(botIdx), botAddr.toLowerCase())
      .set(Math.floor(when.getTime() / 1000));
  }

  public setBotBalance(botIdx: number, botAddr: string, eth: number) {
    this.metricsList.botBalance
      .labels(this.chain, String(botIdx), botAddr.toLowerCase())
      .set(eth);
  }

  public incFundingFailure(botIdx: number, botAddr: string, reason: FundingFailureReason, n: number = 1) {
    if (n <= 0) return;
    this.metricsList.fundingFailures
      .labels(this.chain, String(botIdx), botAddr.toLowerCase(), reason)
      .inc(n);
  }
}
