import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  // Overridable only for the populated-database migration test (tests/migrations.test.ts).
  migrations: { path: process.env.PRISMA_MIGRATIONS_DIR ?? "prisma/migrations" },
  // `prisma generate` does not need a database; migrate/deploy do.
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://invalid:invalid@localhost:5432/invalid" },
});
