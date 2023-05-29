import { ethers } from "ethers";
import { MarketData, PerpetualDataHandler, SmartContractOrder } from "@d8x/perpetuals-sdk";
import { Redis } from "ioredis";
import { constructRedis } from "../utils.ts";

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

    // get order book addresses
    const perpIds: number[] = (await md.getReadOnlyProxyInstance().getPoolStaticInfo(1, 255))[0].flat();
    const obAddr = await Promise.all(perpIds.map((id) => md.getReadOnlyProxyInstance().getOrderBookAddress(id)));

    // smart contracts on ws provider
    const orderBooks = obAddr.map((addr) => new ethers.Contract(addr, md.getABI("lob")!, this.wsProvider));
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

    // add listeners for each order book
    orderBooks.map((ob, idx) => {
      console.log(`Subscribing to ${perpIds[idx]} ${obAddr[idx]}`);
      // order posted
      ob.on("PerpetualLimitOrderCreated", (perpetualId, trader, _brokerAddr, scOrder, digest) => {
        console.log(`${new Date(Date.now()).toISOString()} PerpetualLimitOrderCreated:`, {
          perpetualId: perpetualId,
          trader: trader,
          digest: digest,
        });
        this.redisPubClient.publish(
          "PerpetualLimitOrderCreated",
          JSON.stringify({
            perpetualId: perpetualId,
            trader: trader,
            order: { ...scOrder },
            digest: digest,
          })
        );
      });

      // order execution failed
      ob.on("ExecutionFailed", (perpetualId, _trader, digest, reason) => {
        console.log(`${new Date(Date.now()).toISOString()} ExecutionFailed:`, {
          perpetualId: perpetualId,
          digest: digest,
          reason: reason,
        });
        this.redisPubClient.publish(
          "ExecutionFailed",
          JSON.stringify({ perpetualId: perpetualId, digest: digest, reason: reason })
        );
      });
    });

    // order cancelled
    proxy.on("PerpetualLimitOrderCancelled", (perpetualId, digest) => {
      console.log(`${new Date(Date.now()).toISOString()} PerpetualLimitOrderCancelled:`, {
        perpetualId: perpetualId,
        digest: digest,
      });
      this.redisPubClient.publish(
        "PerpetualLimitOrderCancelled",
        JSON.stringify({ perpetualId: perpetualId, digest: digest })
      );
    });

    // order executed
    proxy.on("Trade", (perpetualId, _traderAddr, _positionId, _order, digest, _fNewPos, _fPrice, _fFee, _fPnLCC) => {
      console.log(`${new Date(Date.now()).toISOString()} Trade:`, {
        perpetualId: perpetualId,
        traderAddr: _traderAddr,
        digest: digest,
      });
      this.redisPubClient.publish("Trade", JSON.stringify({ perpetualId: perpetualId, digest: digest }));
    });
  }
}
