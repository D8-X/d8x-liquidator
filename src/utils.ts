import { Redis } from "ioredis";
import { RedisConfig, LiquidatorConfig } from "./types.js";
import { HDNodeWallet, Mnemonic } from "ethers";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createLogger } from "./logger.js";

const log = createLogger("utils");

const shuffle = (array: string[]): string[] => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return Object.prototype.toString.call(err);
}

export function errCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err) {
    const c: unknown = err.code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Environment variable ${name} not defined`);
  }
  return v;
}

export function requireEnvInt(name: string): number {
  const raw = requireEnv(name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} is not an integer: "${raw}"`);
  }
  return parsed;
}

export async function loadConfig(sdkConfig: string): Promise<LiquidatorConfig> {
  const cfgPath: string | undefined = process.env.LIQUIDATOR_CONFIG_PATH;
  if (cfgPath === undefined) {
    throw new Error("LIQUIDATOR_CONFIG_PATH not defined");
  }
  const configList: LiquidatorConfig[] = JSON.parse(await readFile(cfgPath, "utf8")) as LiquidatorConfig[];
  const config: LiquidatorConfig | undefined = configList.find((c) => c.sdkConfig === sdkConfig);
  if (!config) {
    throw new Error(`SDK Config ${sdkConfig} not found in config file.`);
  }
  config.rpcExec = shuffle(config.rpcExec);
  config.rpcListenHttp = shuffle(config.rpcListenHttp);
  config.rpcWatch = shuffle(config.rpcWatch);
  config.rpcListenWs = shuffle(config.rpcListenWs);
  return config;
}

export interface LoadedAccounts {
  addr: string[];
  pk: string[];
}

export function loadAccounts(mnemonicSeed: string, idxFrom: number, idxTo: number): LoadedAccounts {
  const addr: string[] = [];
  const pk: string[] = [];
  for (let myIdx = idxFrom; myIdx <= idxTo; myIdx++) {
    const [myAddr, myPK] = getPrivateKeyFromSeed(mnemonicSeed, myIdx);
    addr.push(myAddr);
    pk.push(myPK);
  }
  if (pk.length < 1) {
    throw new Error("private key not defined");
  }
  return { addr, pk };
}

export function getPrivateKeyFromSeed(mnemonic: string, idx: number): [string, string] {
  const baseDerivationPath: string = "m/44'/60'/0'/0";
  const path: string = `${baseDerivationPath}/${String(idx)}`;
  const mnemonicWallet: HDNodeWallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(mnemonic), path);
  return [mnemonicWallet.address, mnemonicWallet.privateKey];
}

export function getRedisConfig(): RedisConfig {
  return {
    host: requireEnv("REDIS_HOST"),
    port: requireEnvInt("REDIS_PORT"),
    password: process.env.REDIS_PASSWORD,
    db: requireEnvInt("REDIS_ID"),
  };
}

export function constructRedis(name: string): Redis {
  const redisConfig: RedisConfig = getRedisConfig();
  const client: Redis = new Redis(redisConfig);
  client.on("error", (err: Error): void => {
    log.error({ err, name }, "Redis Client Error");
  });
  return client;
}

/**
 *
 * @param promise async function to be esxecuted
 * @param timeoutMs timeout in MS
 * @param errMsgOnTimeout optional error message
 * @returns function return value or ends in error
 */
export function executeWithTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  errMsgOnTimeout?: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise: Promise<T> = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      const msg: string = errMsgOnTimeout ?? "Function execution timed out.";
      reject(new Error(msg));
    }, timeout);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "bigint") return val.toString();
    if (val instanceof Map) {
      return Array.from(val.entries()).sort((a, b) =>
        JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])),
      );
    }
    if (val instanceof Set) {
      return Array.from(val.values()).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      const obj: Record<string, unknown> = val as Record<string, unknown>;
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return val;
  });
}
