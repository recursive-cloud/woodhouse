/**
 * Structured logging.
 *
 * Probot's built-in logger pretty-prints unless it is constructed through its
 * own `run()` helper, which we deliberately do not use. Building the pino
 * instance ourselves guarantees single-line JSON on stdout for the cluster log
 * forwarder, with no pretty-print transport loaded at all.
 */

import { pino, type Logger } from "pino";

export interface LoggerOptions {
  readonly level: string;
  readonly name?: string;
}

/** Keys that must never reach the log, in case a payload is ever logged whole. */
const REDACTED = [
  "privateKey",
  "private_key",
  "token",
  "secret",
  "authorization",
  "*.token",
  "*.secret",
  "headers.authorization",
];

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name ?? "woodhouse",
    level: options.level,
    // Emit levels as strings; numeric levels are needlessly opaque in a log UI.
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACTED, censor: "[redacted]" },
    base: undefined,
  });
}

export type { Logger };
