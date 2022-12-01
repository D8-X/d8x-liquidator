# D8X Liquidator

Liquidator for D8X Perpetual Futures.

### Install

Run `yarn`.

### Configure

Inspect and edit the liquidator.config.js file to set-up the liquidators. For instance, if you want to run liquidators for BTC and ETH, you could use a config file like this:

```
module.exports = {
  apps: [
    {
      name: "d8x-liquidator-1",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/btc-liquidator-errors.log",
      out_file: "./logs/btc-liquidator-log.log",
      args: "BTC-USD-MATIC",
    },
    {
      name: "d8x-liquidator-2",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/eth-liquidator-errors.log",
      out_file: "./logs/eth-liquidator-log.log",
      args: "ETH-USD-MATIC",
    },
  ],
};
```

### Start

Run `yarn start`.

### Monitor

Inspect logs in the 'logs' folder, or run `pm2 monit`.

### Stop

Run `pm2 stop all && pm2 delete all`.
