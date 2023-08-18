import { ethers } from "ethers";
import { ABK64x64ToFloat, MarketData, PerpetualDataHandler } from "@d8x/perpetuals-sdk";
import { Redis } from "ioredis";
import { chooseRPC, constructRedis } from "../utils";
import { ListenerConfig } from "../types";
import SturdyWebSocket from "sturdy-websocket";
import Websocket from "ws";

enum ListeningMode {
  Polling = "Polling",
  Events = "Events",
}

export default class BlockhainListener {
  private config: ListenerConfig;

  // objects
  private httpProvider: ethers.providers.StaticJsonRpcProvider;
  private listeningProvider: ethers.providers.Provider | ethers.providers.WebSocketProvider | undefined;
  private redisPubClient: Redis;
  private md: MarketData;

  // state
  private blockNumber: number = 0;
  private mode: ListeningMode = ListeningMode.Events;

  constructor(config: ListenerConfig) {
    this.config = config;
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig));
    this.redisPubClient = constructRedis("BlockchainListener");
    this.httpProvider = new ethers.providers.StaticJsonRpcProvider(chooseRPC(this.config.httpRPC));
  }

  public unsubscribe() {
    console.log(`${new Date(Date.now()).toISOString()} BlockchainListener: unsubscribing`);
    if (this.listeningProvider) {
      this.listeningProvider.removeAllListeners();
    }
  }

  public checkHeartbeat(latestBlock: number) {
    if (this.mode == ListeningMode.Polling) {
      return true;
    }
    const isAlive = this.blockNumber + 1 >= latestBlock; // allow one block behind
    if (!isAlive) {
      console.log(`${new Date(Date.now()).toISOString()}: websocket connection ended`);
      console.log(`${new Date(Date.now()).toISOString()}: ws=${this.blockNumber}, http=${latestBlock}`);
      return false;
    }
    console.log(`${new Date(Date.now()).toISOString()}: websocket connection is alive @ block ${latestBlock}`);
    return true;
  }

  private switchListeningMode() {
    // reset
    this.unsubscribe();
    this.blockNumber = 0;
    if (this.mode == ListeningMode.Events) {
      console.log(`${new Date(Date.now()).toISOString()}: switching from WS to HTTP`);
      this.mode = ListeningMode.Polling;
      this.listeningProvider = new ethers.providers.StaticJsonRpcProvider(chooseRPC(this.config.httpRPC));
      this.addListeners(this.listeningProvider);
    } else {
      console.log(`${new Date(Date.now()).toISOString()}: switching from HTTP to WS`);
      this.mode = ListeningMode.Events;
      if (this.listeningProvider) {
        this.listeningProvider.removeAllListeners();
      }
      this.listeningProvider = new ethers.providers.WebSocketProvider(chooseRPC(this.config.wsRPC));
      this.addListeners(this.listeningProvider);
    }
    this.redisPubClient.publish("switch-mode", this.mode);
  }

  public async start() {
    // infer chain from provider
    const network = await this.httpProvider.ready;
    // connect to http provider
    console.log(
      `${new Date(Date.now()).toISOString()}: connected to ${network.name}, chain id ${
        network.chainId
      }, using HTTP provider`
    );
    // connect to ws provider
    if (this.config.wsRPC.length > 0) {
      this.listeningProvider = new ethers.providers.WebSocketProvider(
        new SturdyWebSocket(chooseRPC(this.config.wsRPC), { wsConstructor: Websocket }),
        network
      );
    } else if (this.config.httpRPC.length > 0) {
      this.listeningProvider = new ethers.providers.StaticJsonRpcProvider(chooseRPC(this.config.httpRPC));
    } else {
      throw new Error("Please specify your RPC URLs");
    }

    await this.md.createProxyInstance(this.httpProvider);
    console.log(
      `${new Date(Date.now()).toISOString()}: http connection established with proxy @ ${this.md.getProxyAddress()}`
    );

    // connection is established if we get a block
    setTimeout(() => {
      if (this.blockNumber == 0) {
        console.log(`${new Date(Date.now()).toISOString()}: websocket connection could not be established`);
        this.switchListeningMode();
      } else {
        console.log(`${new Date(Date.now()).toISOString()}: websocket connection established`);
      }
    }, this.config.waitForBlockseconds * 1_000);

    // add listeners
    this.addListeners(this.listeningProvider);

    // periodic health checks
    setInterval(async () => {
      if (this.mode == ListeningMode.Events) {
        // currently on WS - check that block number is still accurate
        const latestBlock = await this.httpProvider.getBlockNumber();
        // if not accurate, switch to http
        if (!this.checkHeartbeat(latestBlock)) {
          this.switchListeningMode();
        }
      } else {
        // currently on HTTP - check if we can switch to WS by seeing if we get blocks
        let success = false;
        let wsProvider = new ethers.providers.WebSocketProvider(
          new SturdyWebSocket(chooseRPC(this.config.wsRPC), { wsConstructor: Websocket }),
          network
        );
        wsProvider.once("block", () => {
          success = true;
        });
        // after N seconds, check if we received a block - if yes, switch
        await setTimeout(async () => {
          if (success) {
            this.switchListeningMode();
          }
        }, this.config.waitForBlockseconds * 1_000);
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  private addListeners(provider: ethers.providers.Provider) {
    // on error terminate
    provider.on("error", (e) => {
      console.log(
        `${new Date(Date.now()).toISOString()} BlockchainListener received error msg in ${this.mode} mode:`,
        e
      );
      this.unsubscribe();
      this.switchListeningMode();
    });

    // broadcast new blocks
    provider.on("block", async (blockNumber) => {
      this.redisPubClient.publish("block", blockNumber.toString());
      if (blockNumber % 10 == 0) {
        console.log(
          `${new Date(Date.now()).toISOString()} BlockchainListener received new block ${blockNumber} @ ts ${
            Date.now() / 1_000
          }, mode: ${this.mode}`
        );
      }
      this.blockNumber = blockNumber;
    });

    // smart contract events
    const proxy = new ethers.Contract(this.md.getProxyAddress(), this.md.getABI("proxy")!, provider);

    // order executed
    proxy.on(
      "Trade",
      (perpetualId, _traderAddr, _positionId, _order, digest, _fNewPos, _fPrice, _fFee, _fPnLCC, _fB2C) => {
        this.redisPubClient.publish("Trade", JSON.stringify({ perpetualId: perpetualId, digest: digest }));
        console.log(`${new Date(Date.now()).toISOString()} Block: ${this.blockNumber}, ${this.mode} mode, Trade:`, {
          perpetualId: perpetualId,
          traderAddr: _traderAddr,
          digest: digest,
        });
      }
    );

    // position liquidated
    proxy.on(
      "Liquidate",
      (
        perpetualId,
        _liquidatorAddr,
        traderAddr,
        _positionId,
        _fLiquidatedAmount,
        _fPrice,
        fNewPositionBC,
        _fFee,
        _fRealizedPnL
      ) => {
        this.redisPubClient.publish(
          "Liquidate",
          JSON.stringify({ perpetualId: perpetualId, traderAddr: traderAddr, fNewPositionBC: fNewPositionBC })
        );
        console.log(`${new Date(Date.now()).toISOString()} Liquidate:`, {
          perpetualId: perpetualId,
          liquidatorAddr: _liquidatorAddr,
          traderAddr: traderAddr,
          fNewPositionBC: ABK64x64ToFloat(fNewPositionBC),
          fLiquidatedAmount: ABK64x64ToFloat(_fLiquidatedAmount),
        });
      }
    );
  }
}
