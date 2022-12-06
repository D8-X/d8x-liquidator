module.exports = {
  apps: [
    {
      name: "d8x-liquidator-1",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/btc-liquidator-errors.log",
      out_file: "./logs/btc-liquidator-log.log",
      args: "BTC-USD-MATIC 0",
    },
    {
      name: "d8x-liquidator-2",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/eth-liquidator-errors.log",
      out_file: "./logs/eth-liquidator-log.log",
      args: "ETH-USD-MATIC 1",
    },
    {
      name: "d8x-liquidator-3",
      script: "./src/main.ts",
      watch: ["./src"],
      error_file: "./logs/matic-liquidator-errors.log",
      out_file: "./logs/matic-liquidator-log.log",
      args: "MATIC-USD-MATIC 2",
    },
  ],
};
