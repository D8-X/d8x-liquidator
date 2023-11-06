# D8X Liquidator

## 1 - Getting started

### Dependencies

These services can be run using [Docker](https://docs.docker.com/get-docker/).

In addition, you will need:

- A mnemonic seed phrase, used to generate private keys for the wallets that will liquidate traders
- RPCs (HTTP and WebSockets) to interact with the blockchain
- Optional: number of different servers running these bots, if applicable

The first address along the seed phrase's derivation path must be funded with with sufficient native tokens to execute liquidatons on-chain. For instance, if running on Polygon zkEVM, the first address needs to have sufficient ETH to pay for gas.

Note that your proceeds are sent to an address of your choice, which need not be associated with the mnemonic seed provided. Hence your earnings are not at risk even if the bots are compromised. Nevertheless we strongly encourage you to use a sufficiently secure network configuration when choosing a server.

## 2 - Configuration

### Environment variables

Rename the file `sample.env` as `.env` and edit as necessary:

These variables have sensible default values, but can be modified if needed:

- ACCOUNTS_PER_BOT: How many wallets will each bot be using.
  - More wallets allows for a larger number of simulateneous liquidations, but will require more gas tokens to be held in the seed phrase's wallet
- REDIS_URL
- REDIS_PASSWORD

These variables depend on your setup:

- CHAIN_ID: The chain ID of the network where traders are liquidated
- PEER_COUNT: Number of servers running bots. Defaults to 1 (single-server setup)
- PEER_INDEX: 0-indexed identifier, unique for each server. Defaults to 0 (single-server setup)
- EARNINGS_WALLET: Address of the wallet that will collect all earnings from liquidations
- SEED_PHRASE: Your mnemonic seed phrase.
  - Remember to fund the first address along the derivation path.
  - You can create a seed phrase e.g. by creating a new Metamask wallet, exporting the seed phrase, and funding the first account in this wallet with sufficient native tokens.

### Parameter files

Navigate to src/config, where you will find two files, `sample.liquidatorConfig.json` and `sample.listenrConfig.json`. Replace `sample` by `live` and use these files to enter your own RPCs. The liquidator configuration requires only HTTP providers, and the listener configuration requires both HTTP and WebSockets.

All other values can be left unchanged.

### Docker Compose

Inspect the file `perpetuals.yml`, and edit as follows:

- The services named `redis` and `blockchain-streamer` must be left untouched.
- The services under `Liquidators` indicate which perpetual orders will be executed.
  - Each perpetual should use a different value for `WALLET_INDEX` for best performance.
  - If using a multi-server setup, we recommend either using different seed phrases. Note that in this case you must also specify different values for `PEER_INDEX` in the corresponding `.env` files.
- A file named `perpetuals-testnet.yml` is provided, fully populated with all the details needed to run the bots on testnet. You may use this as guidance when populating your own `perpetuals.yml` file.

## 3 - Starting the bots

### Testnet

Start all the liquidator bots on testnet by running

```
$ sudo docker compose -f perpetuals-testnet.yml up --build
```

### Mainnet

If you have already properly configured all the perpetuals you want to run in the `perpetuals.yml` file, then you can start the bots by running:

```
$ sudo docker compose -f perpetuals.yml up --build
```
