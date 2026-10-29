import pino from "pino";

/**
 * Paths that may hold secrets. pino replaces them with "[REDACTED]" before anything is written.
 * Credentials are never logged on purpose either; this is the safety net (CLAUDE.md).
 */
export const REDACT_PATHS = [
  "password",
  "*.password",
  "secret",
  "*.secret",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "apiKey",
  "*.apiKey",
  "app_secret",
  "*.app_secret",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "headers.cookie",
  "*.headers.cookie",
  "credentials",
  "*.credentials",
  "totp",
  "*.totp",
  "totpSecret",
  "*.totpSecret",
];

export function createLogger(options: pino.LoggerOptions = {}, stream?: pino.DestinationStream) {
  return pino(
    {
      level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      base: { service: process.env.SERVICE_NAME ?? "web" },
      ...options,
    },
    stream,
  );
}

export const logger = createLogger();
