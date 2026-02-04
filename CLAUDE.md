# D8X Liquidator

This repository contains a liquidation bot system for the D8X decentralized perpetual futures protocol. The system monitors trader positions and executes liquidations when margin requirements are not met.

## Architecture Overview

The system uses a microservice architecture with three components communicating via Redis pub/sub:

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Sentinel   │─────▶│  Commander  │─────▶│  Executor   │
│ (listener)  │      │(distributor)│      │(liquidator) │
└─────────────┘      └─────────────┘      └─────────────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                           │
                       ┌───────┐
                       │ Redis │
                       └───────┘
```

### Components

**Sentinel** (`src/sentinel/`)
- Listens to blockchain events via WebSocket or HTTP polling
- Publishes events to Redis: `block`, `LiquidateEvent`, `UpdateMarginAccountEvent`, `UpdateMarkPriceEvent`
- Automatically switches between WS and HTTP providers on failures
- Entry: `src/sentinel/main.ts`

**Commander** (`src/commander/`)
- Maintains in-memory state of all open positions per perpetual
- Fetches and refreshes active accounts periodically
- Calculates margin safety using price feeds (Pyth/Odin)
- Publishes `LiquidateTrader` messages when positions become unsafe
- Entry: `src/commander/main.ts`

**Executor** (`src/executor/`)
- Subscribes to `LiquidateTrader` messages
- Manages multiple bot wallets for parallel liquidation execution
- Handles transaction submission, confirmation, and retry logic
- Auto-funds bot wallets from treasury when low on gas
- Exposes Prometheus metrics on port 9001
- Entry: `src/executor/main.ts`

## Key Files

| File | Purpose |
|------|---------|
| `src/types.ts` | Shared TypeScript interfaces and types |
| `src/utils.ts` | Config loading, Redis setup, wallet derivation |
| `src/multiUrlJsonRpcProvider.ts` | Fault-tolerant HTTP RPC provider with auto-failover |
| `src/multiUrlWebsocketProvider.ts` | Fault-tolerant WebSocket provider with auto-failover |
| `src/executor/metrics.ts` | Prometheus metrics for monitoring |
| `src/executor/rpcManager.ts` | RPC health checking (legacy, mostly unused) |

## Development

### Prerequisites
- Node.js >= 20
- Yarn
- Access to `@d8-x/d8x-node-sdk` (GitHub Packages)

### Setup
```bash
# Create .npmrc with GitHub token for @d8-x packages
cp dotnpmrcexample .npmrc
# Edit .npmrc and set NODE_AUTH_TOKEN

# Install dependencies
yarn

# Build
yarn build
```

### Running Locally
```bash
# Each component needs SDK_CONFIG, LIQUIDATOR_CONFIG_PATH, and Redis env vars
export SDK_CONFIG=base_sepolia
export LIQUIDATOR_CONFIG_PATH=./config/live.liquidatorConfig.json
export REDIS_HOST=localhost REDIS_PORT=6379 REDIS_PASSWORD=yourpassword REDIS_ID=0

yarn start-sentinel
yarn start-commander
yarn start-executor   # Also needs SEED_PHRASE
```

## Configuration

### Environment Variables
| Variable | Description |
|----------|-------------|
| `SDK_CONFIG` | D8X SDK config name (e.g., `base_sepolia`, `zkevm`) |
| `SEED_PHRASE` | Mnemonic for wallet derivation (executor only) |
| `LIQUIDATOR_CONFIG_PATH` | Path to JSON config file |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_ID` | Redis connection |

### Liquidator Config (`config/live.liquidatorConfig.json`)
Array of chain configs with fields:
- `sdkConfig`: SDK config name
- `bots`: Number of parallel executor bots
- `rewardsAddress`: Address to receive liquidation rewards
- `rpcExec`, `rpcWatch`, `rpcListenHttp`, `rpcListenWs`: RPC URLs by purpose
- `waitForBlockSeconds`: Max time between blocks before switching providers
- `refreshAccountsIntervalSecondsMin/Max`: Account refresh frequency
- `liquidateIntervalSecondsMin/Max`: Liquidation attempt frequency
- `gasPriceMultiplier`, `maxGasPriceGWei`, `gasLimit`: Gas settings
- `priceFeedEndpoints`: Pyth/Odin price feed configuration

## Deployment

Uses Docker Compose with three services per chain:
```bash
docker compose up --build -d
```

Images are built and pushed to GHCR on pushes to `main`/`dev` branches.

### Wallet Structure
- Index 0: Treasury wallet (funds bot wallets)
- Index 1 to N: Bot wallets (execute liquidations)

The treasury automatically funds bots when their balance falls below the minimum required for gas.

## Monitoring

- Prometheus metrics exposed at `http://localhost:9001/metrics`
- Alertmanager integration for Slack notifications
- Key metrics: `liquidation_transaction_*` (submissions, confirmations, failures, rejections)

## Dependencies

- `@d8-x/d8x-node-sdk`: D8X protocol SDK
- `ethers`: Ethereum interactions
- `ioredis`: Redis client
- `prom-client`: Prometheus metrics
- `express`: Metrics HTTP server

## Code Patterns

### Multi-URL Providers
Both `MultiUrlJsonRpcProvider` and `MultiUrlWebSocketProvider` implement automatic failover across multiple RPC endpoints. They track errors and switch to the next URL when failures occur.

### Margin Safety Calculation
In `distributor.ts`, `isMarginSafe()` computes:
```
balance = cash + (position * markPrice - lockedInValue) / S3
maintenanceMargin = |position| * markPrice / S3 * maintenanceRate
safe = balance >= maintenanceMargin
```

### Prediction Markets
Special handling for prediction markets using `pmExcessBalance()` from the SDK.
