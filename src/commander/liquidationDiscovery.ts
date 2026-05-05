import { IPerpetualManager, IdxPriceInfo, floatToABK64x64 } from "@d8-x/d8x-node-sdk";
import type { Provider } from "ethers";

export type FixedIdxPrice = [bigint, bigint, bigint];

export function toFixedIdxPrice(px: IdxPriceInfo): FixedIdxPrice {
  return [
    floatToABK64x64(px.s2),
    floatToABK64x64(px.s3 ?? 0),
    floatToABK64x64(px.rho ?? 0),
  ];
}

export async function findLiquidatableTraders(
  proxy: IPerpetualManager,
  provider: Provider,
  perpId: number,
  fIdxPx: FixedIdxPrice,
): Promise<string[]> {
  const result = await proxy.connect(provider).getLiquidatableAccounts(perpId, fIdxPx);
  return result.map((addr) => addr.toLowerCase());
}
