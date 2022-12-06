import { LiqConfig, watchDogAlarm } from "./types";
import { readFileSync } from "fs";
const pm2 = require("pm2");
import { setTimeout } from "timers/promises";

export default class WatchDog {
  private watchList: string[] = [];
  private config: LiqConfig;

  constructor(config: LiqConfig) {
    this.config = config;
  }

  /**
   * Add a symbol to watch-list
   * @param {string} name Symbol to watch (e.g. BTC-USD-MATIC)
   */
  public addWatchee(name: string) {
    name = name.toUpperCase();
    this.watchList.push(name);
  }

  /**
   * write current UTC timestamp to file for watcher
   */
  private readPulseLogFile(name: string) {
    let filename = this.config.watchDogPulseLogDir + "/pulse" + name + ".txt";
    return readFileSync(filename, "utf-8");
  }

  /**
   * Return true if we have no recent pulse from watched order-book
   * @param name name of order-book (e.g. BTC-USD-MATIC)
   * @returns true if timeout
   */
  public checkWatcheeTimeOut(name: string): boolean {
    let ts: string;
    try {
      ts = this.readPulseLogFile(name);
    } catch (err) {
      console.log(`could not read pulse file: ${err}`);
      // this case should only occur if
      // the process has not logged yet
      return false;
    }
    let timeSince = (Date.now() - parseInt(ts)) / 1000;
    return timeSince > this.config.watchDogMaxTimeSeconds;
  }

  /**
   * Restart the process for a given name via pm2
   */
  private async restartProcess(name: string): Promise<any> {
    // turn call-back functions into promise
    return await new Promise((resolve) =>
      pm2.connect(true, function (err: any) {
        if (err) {
          console.error(err);
          resolve(err);
        }
        pm2.list((err: any, list: any) => {
          if (err) {
            console.error(err);
            resolve(err);
          }
          let k = 0;
          for (; k < list.length; k++) {
            if (list[k].name.toUpperCase() == name) {
              console.log("Found problematic", name);
              pm2.restart(list[k].name, (err: any, proc: any) => {
                if (err) {
                  console.error(err);
                  resolve(err);
                }

                console.log("Restarted", name);
                pm2.disconnect();
                resolve("restarted");
              });
              break;
            }
          }
          if (list[k].name.toUpperCase() != name) {
            resolve("name not found");
          }
        });
      })
    );
  }

  /**
   * Report a problem
   * This method restarts the process, see https://pm2.keymetrics.io/docs/usage/pm2-api/
   * @param name name of order-book (e.g., MATIC-USD-MATIC)
   */
  private async reportProblem(name: string) {
    let res = await this.restartProcess(name);
    if (res == "name not found") {
      console.log(`Problematic ${name} not found yet.`);
    } else if (res != "restarted") {
      console.log(`Problematic ${name} could not be restarted: ${res}`);
    }
  }

  /**
   * Check all watchList for timeout
   * @param isInCoolOff don't check and report if in cool-off
   * @returns bool-array whether watchee timed out
   */
  public async informIfTimeouts(coolOffRecording: Array<watchDogAlarm>): Promise<boolean[]> {
    let isTimeOut: boolean[] = [];
    for (let k = 0; k < this.watchList.length; k++) {
      let noPulse = this.checkWatcheeTimeOut(this.watchList[k]);
      if (
        coolOffRecording[k].isCoolOff &&
        Date.now() / 1000 - coolOffRecording[k].timestampSec > this.config.watchDogAlarmCoolOffSeconds
      ) {
        // reset cooloff
        coolOffRecording[k].isCoolOff = false;
      }
      if (!coolOffRecording[k].isCoolOff && noPulse) {
        // report
        await this.reportProblem(this.watchList[k]);
        console.log("reported");
        // set to cool off
        coolOffRecording[k].isCoolOff = true;
        coolOffRecording[k].timestampSec = Date.now() / 1000;
      }
      isTimeOut.push(noPulse);
    }
    return isTimeOut;
  }

  public async runUntilKilled() {
    let coolOffRecording: Array<watchDogAlarm> = new Array<watchDogAlarm>();
    for (let k = 0; k < this.watchList.length; k++) {
      coolOffRecording.push({ isCoolOff: false, timestampSec: Date.now() / 1000 });
    }
    while (true) {
      let timeStart = Date.now();
      console.log(`${new Date(timeStart).toISOString()}: checking`);
      await this.informIfTimeouts(coolOffRecording);
      let timeElapsed = Date.now() - timeStart;
      await setTimeout(Math.max(0, this.config.watchDogMaxTimeSeconds * 1000 - timeElapsed));
    }
  }
}
