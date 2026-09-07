/**
 * Structured JSON logging (pino). Pretty output when a TTY is attached and
 * `LOG_PRETTY` is not `0`; plain JSON in CI so logs are greppable.
 *
 * @module logger
 */
import pino from "pino";

const pretty = process.stdout.isTTY && process.env.LOG_PRETTY !== "0";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "osceola-pipeline" },
  redact: {
    paths: ["*.secretAccessKey", "*.accessKeyId", "*.authorization"],
    censor: "[redacted]",
  },
  ...(pretty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
