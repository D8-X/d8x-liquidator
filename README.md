# D8X Liquidator

## 1 - Getting started

### Dependencies

These services can be run using [Docker](https://docs.docker.com/get-docker/).

In addition, you will need:

- A mnemonic seed phrase, used to generate private keys for the wallets that will liquidate traders
- An address to receive the earned rewards
- RPC node URLs (HTTP and WebSockets) to interact with the blockchain

The first address along the seed phrase's derivation path must be funded with with sufficient native tokens to execute liquidatons on-chain. For instance, if running on Polygon zkEVM, the first address needs to have sufficient ETH to pay for gas.

Note that your proceeds are sent to an address of your choice, which need not be associated with the mnemonic seed provided. Hence your earnings are not at risk even if the server is compromised. Nevertheless we strongly encourage you to use a sufficiently secure network configuration when choosing a server.

## 2 - Configuration

### Environment variables

Rename the file `sample.env` as `.env` and edit as necessary:

- SDK_CONFIG: The D8X Perpetuals SDK confgi name of the network where traders are liquidated, e.g. "zkevm"
- EARNINGS_WALLET: Address of the wallet that will collect all earnings from liquidations
- SEED_PHRASE: Your mnemonic seed phrase.
  - Remember to fund the first address along the derivation path.
  - You can create a seed phrase e.g. by creating a new Metamask wallet, exporting the seed phrase, and funding the first account in this wallet with sufficient native tokens.

### Parameter file

Navigate to src/config, where you will find the files `sample.liquidatorConfig.json`. Rename it replacing `sample` by `live` and use these files to enter your own RPCs.

All other values can be left unchanged.

## 3 - Starting the bots

Start all the liquidator bots on testnet by running

```
$ sudo docker compose up --build -d
```
