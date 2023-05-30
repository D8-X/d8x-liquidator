# D8X Liquidator

## Getting started

### Dependencies

These services can be run using either [Docker](https://docs.docker.com/get-docker/) or [Yarn](https://yarnpkg.com/getting-started/install).

In addition, you will need:

- A mnemonic phrase used to generate the private keys for the wallets you will be using
- RPCs (HTTP and WebSockets) to interact with the blockchain

Use the provided `.env` file to enter your mnemonic seed phrase and RPCs. A set of common free/public RPCs is also provideed in src/liquidatorConfig.json, which you may edit as needed.

Each wallet needs to be funded with sufficient native tokens to liquidate positions, and will be credited in the collateral currency of the corresponding perpetual. For instance, if running on Polygon zkEVM, the wallets need to have ETH for gas, and if running on Polygon PoS, they need to have MATIC.

## Configuration

### Environment variables

Rename the file `sample.env` as `.env` and edit as necessary:

- REDIS_URL and REDIS_PASSWORD: you may leave these unchanged if running with Docker. See in-line comments otherwise.
- RPC_HTTP_URL, RPC_WS_URL: your own RPCs
- RPC_USE_OWN_ONLY: whether to use public RPCs for liquidations; your own RPCs above are still required for streaming blockchain events.
- SEED_PHRASE: your mnemonic seed phrase.

### With Docker

Inspect the file `docker-compose.yml`. The services named `liquidator-1`, `liquidator-2`, etc contain the symbols and wallet indices to run. You may remove or add more bots following the provided syntax.

### Without Docker

Inspect and edit the liquidatorConfig.json file. Most importantly, ensure the RPCs include only those corresponding to the network of interest. The perpetual network is always inferred from the chain ID of the RPC provider.

Inspect and edit the ecosystem.config.js file to set-up the bots.

The arguments for each bot are:

- Symbol of the form BTC-USD-MATIC
- From-to indices along the derivation path of your mnemonic seed: "from" is mandatory, and "to" is optional (in case you want to use more than one wallet in one perpetual because of e.g. high market volatility)

For instance, the below configuration is used to liquidate ETH-USD and BTC-USD positions in a MATIC pool, using the second and third wallets, respectively.

#### ecosystem.config.js

```
module.exports = {
  apps: [
        {
      name: "ETH-USD-MATIC",
      script: "dist/src/liquidator/main.js",
      watch: ["dist/src/liquidator", "/node_modules/"],
      error_file: "logs/liquidator-errors.log",
      out_file: "logs/liquidator.log",
      args: "ETH-USD-MATIC 1",
      namespace: "liquidator",
    },
    {
      name: "BTC-USD-MATIC",
      script: "dist/src/liquidator/main.js",
      watch: ["dist/src/liquidator", "/node_modules/"],
      error_file: "logs/liquidator-errors.log",
      out_file: "logs/liquidator.log",
      args: "BTC-USD-MATIC 2",
      namespace: "liquidator",
    },
    {
      name: "Watchdog",
      script:
        "node dist/src/runWatchDog.js ETH-USD-MATIC BTC-USD-MATIC",
      watch: ["./src"],
      error_file: "./logs/watchdog-errors.log",
      out_file: "./logs/watchdog.log",
      namespace: "liquidator",
    },
  ],
};
```

## Starting the Liquidators

### With Docker

Start all services by running

```
$ sudo docker-compose up --build
```

### Without Docker

If running without Docker, you must start the services in the following order:

#### Redis

```
$ sudo /etc/init.d/redis-server stop
$ redis-server
```

#### Blockhain event streamer

```
$ yarn start-streamer
```

#### Liquidators

```
$ yarn start-liquidators
```

#### Monitor

Inspect logs in the 'logs' folder, or run `yarn run pm2 monit`.

#### Restart

Run `yarn restart` to force the processes to stop and start again.

#### Clean

Run `yarn clean-logs` to delete all log files. This action is permanent.

#### Stop

Run `yarn stop` to stop all the processes.
