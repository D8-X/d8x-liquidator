import * as promClient from "prom-client";
import express from "express";
import { createLogger } from "../logger.js";

const log = createLogger("commander.metrics");

export class CommanderMetrics {
  private readonly chain: string;

  constructor(
    chain: string = process.env.SDK_CONFIG ?? "unknown",
    private port: number = parseInt(process.env.METRICS_PORT ?? "9011", 10),
    private endpoint: string = "metrics",
    private metricsList = {
      lastPoolCheckSeconds: new promClient.Gauge({
        name: "liquidator_last_pool_check_seconds",
        help: "Unix timestamp of the last getLiquidatableAccountsInPool call, per pool and status.",
        labelNames: ["chain", "pool_id", "status"] as const,
      }),
      poolChecksTotal: new promClient.Counter({
        name: "liquidator_pool_checks_total",
        help: "Cumulative count of getLiquidatableAccountsInPool calls, per pool and status.",
        labelNames: ["chain", "pool_id", "status"] as const,
      }),
      lastPoolLiquidatableCount: new promClient.Gauge({
        name: "liquidator_last_pool_liquidatable_count",
        help: "Number of liquidatable traders returned by the last successful pool check.",
        labelNames: ["chain", "pool_id"] as const,
      }),
    },
  ) {
    this.chain = chain;
  }

  public async start() {
    const app = express();
    app.get(`/${this.endpoint}`, async (_req: any, res: any) => {
      res.set("Content-Type", promClient.register.contentType);
      res.end(await promClient.register.metrics());
    });
    log.info({ port: this.port, endpoint: this.endpoint }, "starting commander metrics endpoint");
    app.listen(this.port);
  }

  public observePoolCheck(poolId: number, status: "ok" | "failed", liquidatableCount: number) {
    const labels = { chain: this.chain, pool_id: String(poolId), status };
    this.metricsList.lastPoolCheckSeconds.set(labels, Math.floor(Date.now() / 1000));
    this.metricsList.poolChecksTotal.inc(labels);
    if (status === "ok") {
      this.metricsList.lastPoolLiquidatableCount
        .labels(this.chain, String(poolId))
        .set(liquidatableCount);
    }
  }
}
