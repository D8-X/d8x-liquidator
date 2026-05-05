import { pino, Logger } from "pino";

const usePretty = process.env.LOG_PRETTY === "true" || process.env.NODE_ENV !== "production";

export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export function createLogger(component: string): Logger {
  return rootLogger.child({ component });
}
