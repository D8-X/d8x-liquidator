import * as promClient from "prom-client";
import express from "express";

export enum OrderExecutionError {
  insufficient_funds = "insufficient_funds",
  order_not_found = "order_not_found",
  too_low_gas_price = "too_low_gas_price",
  too_low_intrinsic_gas = "too_low_intrinsic_gas",
}

export class Metrics {
  constructor(
    // Port on which metrics endpoint server will be exposed
    private port: number = 9001,
    // Endpoint on which the metrics will be exposed
    private endpoint: string = "metrics",

    // All the exported metrics below
    private metricsList = {
      liquidationTransactionFailures: new promClient.Counter({
        name: "liquidation_transaction_failures",
        help: "Cumulative amount of liquidation transaction failures",
      }),
      liquidationTransactionConfirmation: new promClient.Counter({
        name: "liquidation_transaction_confirmations",
        help: "Cumulative amount of liquidation transaction successes",
      }),
      liquidationTransactionRejects: new promClient.Counter({
        name: "liquidation_transaction_rejections",
        help: "Cumulative amount of liquidation transaction rejections",
      }),
      liquidationTransactionSubmissions: new promClient.Counter({
        name: "liquidation_transaction_submissions",
        help: "Cumulative amount of liquidation transaction submissions",
      }),
      fundingFailures: new promClient.Counter({
        name: "funding_failures",
        help: "Cumulative amount of bot funding failures",
      }),
    }
  ) {}

  /**
   * Start the metrics endpoint
   */
  public async start() {
    setInterval(() => {
      this.incFundingFailure();
    }, 100);

    this.metricsEndpoint(this.port, this.endpoint);
  }

  /**
   * Exposes metrics endpoint at given port
   * @param port
   */
  private async metricsEndpoint(port: number, endpoint: string = "metrics") {
    const app = express();
    app.get(`/${endpoint}`, async (req: any, res: any) => {
      res.set("Content-Type", promClient.register.contentType);
      res.end(await promClient.register.metrics());
    });
    console.log(`Starting metrics endpoint available at http://localhost:${port}/${endpoint}`);
    app.listen(port);
  }

  public incrTxRejects() {
    this.metricsList.liquidationTransactionRejects.inc();
  }
  public incrTxFailures() {
    this.metricsList.liquidationTransactionFailures.inc();
  }
  public incrTxConfirmations() {
    this.metricsList.liquidationTransactionConfirmation.inc();
  }
  public incrTxSubmissions() {
    this.metricsList.liquidationTransactionSubmissions.inc();
  }
  public incFundingFailure() {
    this.metricsList.fundingFailures.inc();
  }
}
