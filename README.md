# D8X Liquidator

## 1 - Getting started

### Dependencies

These services can be run using [Docker](https://docs.docker.com/get-docker/).

In addition, you will need:

- A mnemonic seed phrase, used to generate private keys for the wallets that will liquidate traders
- An address to receive the earned rewards
- RPC node URLs (HTTP and WebSockets) to interact with the blockchain

The first address along the seed phrase's derivation path must be funded with with sufficient native tokens to execute liquidatons on-chain. For instance, if running on Polygon zkEVM, the first address needs to have sufficient ETH to pay for gas.

Note that your proceeds are sent to an address of your choice, which need not be associated with the mnemonic seed provided. Hence your earnings are not at risk even if the mnemonic seed is compromised. Nevertheless we strongly encourage you to use a sufficiently secure network configuration when choosing a server.

## 2 - Configuration

### Environment variables

Create a copy of the file [sample.env](./sample.env) and rename it to `.env`. You will need to enter a mnemonic seed phrase in the variable named SEED_PHRASE. Remember to fund the first address along the derivation path. You can create a seed phrase e.g. by creating a new Metamask wallet, exporting the seed phrase, and funding the first account in this wallet with sufficient native tokens.

### Docker Compose

Edit the file [docker-compose.yml](./docker-compose.yml):

- Create copies of the sentinel, commander and executor processes, renaming them following the convention `service-chain` (e.g. `sentinel-arbitrum`).
- In each copy, enter the corresponding D8X SDK config name, and a Redis ID unique to that chain.

### Parameter file

Navigate to src/config, where you will find the files `sample.liquidatorConfig.json`. Rename it replacing `sample` by `live`, and enter the address where rewards will be credited in the field called _rewardsAddress_. All other values can be left unchanged, though we strongly recommend you use additional RPCs, especially for Websockets.

## 3 - Starting the bots

Start all the liquidator bots by running

```
$ sudo docker compose up --build -d
```
