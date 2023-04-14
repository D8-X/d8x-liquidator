module.exports = {
  apps: [
    {
      name: "MATIC-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/matic-usd-matic.log",
      args: "MATIC-USD-MATIC 0",
      namespace: "liquidator"
    },
    {
      name: "ETH-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/eth-usd-matic.log",
      args: "ETH-USD-MATIC 1",
      namespace: "liquidator"
    },
    {
      name: "BTC-USD-MATIC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/btc-usd-matic.log",
      args: "BTC-USD-MATIC 2",
      namespace: "liquidator"
    },
    {
      name: "MATIC-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/matic-usdc-usdc.log",
      args: "MATIC-USDC-USDC 3",
      namespace: "liquidator"
    },
    {
      name: "ETH-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/eth-usdc-usdc.log",
      args: "ETH-USDC-USDC 4",
      namespace: "liquidator"
    },
    {
      name: "BTC-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/btc-usdc-usdc.log",
      args: "BTC-USDC-USDC 5",
      namespace: "liquidator"
    },
    {
      name: "CHF-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/chf-usdc-usdc.log",
      args: "CHF-USDC-USDC 6",
      namespace: "liquidator"
    },
    {
      name: "GBP-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/gbp-usdc-usdc.log",
      args: "GBP-USDC-USDC 7",
      namespace: "liquidator"
    },
    {
      name: "XAU-USDC-USDC",
      script: "./src/main.ts",
      watch: ["./src", "./node_modules/"],
      error_file: "./logs/liquidator-errors.log",
      out_file: "./logs/xau-usdc-usdc.log",
      args: "XAU-USDC-USDC 8",
      namespace: "liquidator"
    },
    {
      name: "Watchdog",
      script: "ts-node ./src/runWatchDog.ts MATIC-USD-MATIC ETH-USD-MATIC BTC-USD-MATIC MATIC-USDC-USDC ETH-USDC-USDC BTC-USDC-USDC CHF-USDC-USDC GBP-USDC-USDC XAU-USDC-USDC",
      watch: ["./src"],
      error_file: "./logs/watchdog-errors.log",
      out_file: "./logs/watchdog.log",
      namespace: "liquidator"
    },
  ],
};
