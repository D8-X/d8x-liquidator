import { ethers } from "ethers";
import { MarketData, PerpetualDataHandler, SmartContractOrder } from "@d8x/perpetuals-sdk";
import { Redis } from "ioredis";
import { constructRedis } from "../utils";

export default class BlockhainListener {
  private httpProvider: ethers.providers.StaticJsonRpcProvider;
  private wsProvider: ethers.providers.WebSocketProvider;
  private redisPubClient: Redis;
  private blockNumber: number = Infinity;

  constructor(httpProvider: ethers.providers.StaticJsonRpcProvider, wsProvider: ethers.providers.WebSocketProvider) {
    this.httpProvider = httpProvider;
    this.wsProvider = wsProvider;
    this.redisPubClient = constructRedis("BlockchainListener");
  }

  private unsubscribe() {
    console.log(`${new Date(Date.now()).toISOString()} BlockchainListener: unsubscribing`);
    this.httpProvider.removeAllListeners();
    this.wsProvider.removeAllListeners();
  }

  public checkHeartbeat(latestBlock: number) {
    const isAlive = this.blockNumber + 1 >= latestBlock; // allow one block behind
    if (!isAlive) {
      console.log(`${new Date(Date.now()).toISOString()}: websocket connection ended`);
      console.log(`${new Date(Date.now()).toISOString()}: ws=${this.blockNumber}, http=${latestBlock}`);
      process.exit(1);
    }
    console.log(`${new Date(Date.now()).toISOString()}: websocket connection is alive @ block ${latestBlock}`);
  }

  public async listen() {
    // infer chain from provider
    const chainId = (await this.httpProvider.getNetwork()).chainId;
    const config = PerpetualDataHandler.readSDKConfig(chainId);

    // connect to http provider
    const md = new MarketData(config);
    await md.createProxyInstance();

    // smart contracts on ws provider
    const proxy = new ethers.Contract(md.getProxyAddress(), md.getABI("proxy")!, this.wsProvider);

    // listeners:

    // on error terminate
    this.wsProvider.on("error", (e) => {
      this.unsubscribe();
      process.exit(1);
    });

    // broadcast new blocks
    this.wsProvider.on("block", async (blockNumber) => {
      if (blockNumber % 300 == 0) {
        console.log(
          `${new Date(Date.now()).toISOString()} BlockchainListener alive @ block ${blockNumber} / ts ${
            Date.now() / 1_000
          }`
        );
      }
      this.blockNumber = blockNumber;
      this.redisPubClient.publish("block", blockNumber.toString());
    });

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
        console.log(`${new Date(Date.now()).toISOString()} Liquidate:`, {
          perpetualId: perpetualId,
          _liquidatorAddr: _liquidatorAddr,
          traderAddr: traderAddr,
          fNewPositionBC: fNewPositionBC,
          _fLiquidatedAmount: _fLiquidatedAmount,
        });
        this.redisPubClient.publish(
          "Liquidate",
          JSON.stringify({ perpetualId: perpetualId, traderAddr: traderAddr, fNewPositionBC: fNewPositionBC })
        );
      }
    );

    // order executed
    proxy.on(
      "Trade",
      (perpetualId, traderAddr, _positionId, _order, digest, fNewPositionBC, _fPrice, _fFee, _fPnLCC) => {
        console.log(`${new Date(Date.now()).toISOString()} Trade:`, {
          perpetualId: perpetualId,
          traderAddr: traderAddr,
          fNewPositionBC: fNewPositionBC,
          digest: digest,
        });
        this.redisPubClient.publish(
          "Trade",
          JSON.stringify({
            perpetualId: perpetualId,
            traderAddr: traderAddr,
            fNewPositionBC: fNewPositionBC,
            digest: digest,
          })
        );
      }
    );
  }
}
