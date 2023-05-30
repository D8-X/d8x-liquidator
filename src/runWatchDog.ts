import { loadConfig } from "./utils";
import WatchDog from "./watchdog";

async function start() {
  let args = process.argv.slice(2);
  if (args.length == 0) {
    throw new Error("watchdog requires arguments e.g. ETH-USD-MATIC BTC-USD-MATIC");
  }
  let config = loadConfig();
  let dog = new WatchDog(config);
  for (let k = 0; k < args.length; k++) {
    console.log(`watching ${args[k]}`);
    dog.addWatchee(args[k]);
  }
  await dog.runUntilKilled();
}

start();
