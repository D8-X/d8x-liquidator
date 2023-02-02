module.exports = {
  apps: [
    {
      name: "Liquidator:BTC-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/btc-liquidator-errors.log",
      out_file: "./logs/btc-liquidator-log.log",
      args: "BTC-USD-MATIC 0",
    },
    {
      name: "Liquidator:ETH-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/eth-liquidator-errors.log",
      out_file: "./logs/eth-liquidator-log.log",
      args: "ETH-USD-MATIC 1",
    },
    {
      name: "Liquidator:MATIC-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/matic-liquidator-errors.log",
      out_file: "./logs/matic-liquidator-log.log",
      args: "MATIC-USD-MATIC 2",
    },
    {
      name: "Liquidator:Watchdog",
      script: "ts-node ./src/runWatchDog.ts BTC-USD-MATIC ETH-USD-MATIC MATIC-USD-MATIC",
      watch: ["./src"],
      error_file: "./logs/watchdog-errors.log",
      out_file: "./logs/watchdog-log.log",
    },
  ],
};
