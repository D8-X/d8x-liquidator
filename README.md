# D8X Liquidator

Liquidator for D8X Perpetual Futures.

## Getting started

### Pre-requisites

You will need a mnemonic phrase used to generate as many private keys as liquidators you will be running.

Each wallet needs to be funded with MATIC in order to execute liquidations, and will be credited in the collateral currency of the perpetuals on which the liquidations would happen.

### Installation

Run `yarn` to install this package and the required dependencies.

## Configuration

Inspect and edit the ecosystem.config.js file to set-up the liquidators.

The fields you may want to modify from their default values are "name" and "args": the former is used to uniquely identify the process within PM2; the latter contains the symbol for which to look for liquidation oportunities, and the index of the private key as generated from the mnemonic phrase.

For instance, if you want to run liquidators for BTC and ETH only, using the third and fourth private keys derived from your seed phrase, you would use a config file like this:

```
module.exports = {
  apps: [
    {
      name: "Liquidator:BTC-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/btc-liquidator-errors.log",
      out_file: "./logs/btc-liquidator-log.log",
      args: "BTC-USD-MATIC 3",
    },
    {
      name: "Liquidator:ETH-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/eth-liquidator-errors.log",
      out_file: "./logs/eth-liquidator-log.log",
      args: "ETH-USD-MATIC 4",
    },
    {
      name: "Liquidator:Watchdog",
      script: "ts-node ./src/runWatchDog.ts BTC-USD-MATIC ETH-USD-MATIC",
      watch: ["./src"],
      error_file: "./logs/watchdog-errors.log",
      out_file: "./logs/watchdog-log.log",
    },
  ],
};

```

## Start

The liquidators, as defined in the configuration file, can be starting by running `yarn start` on the command line.

## Monitor

Inspect logs in the 'logs' folder, or run `pm2 monit`.

### Stop

Run `yarn stop`.
