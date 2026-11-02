import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.CREDENTIALS_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.AUTH_SECRET ??= "test-auth-secret-not-for-production";
