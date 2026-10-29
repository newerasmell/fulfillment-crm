import pino from "pino";

/**
 * Paths that may hold secrets. pino replaces them with "[REDACTED]" before anything is written.
 * Credentials are never logged on purpose either; this is the safety net (CLAUDE.md).
 */
const SECRET_KEYS = [
  "password",
  "passwordHash",
  "secret",
  "app_secret",
  "appSecret",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "authorization",
  "cookie",
  "credentials",
  "ciphertext",
  "authTag",
  "totp",
  "totpSecret",
  "totpSecretEnc",
];

/** Redacted at the top level and up to three levels deep (pino paths do not support recursion). */
export const REDACT_PATHS = SECRET_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`, `*.*.*.${k}`]);

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
