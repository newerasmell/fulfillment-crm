import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // `prisma generate` does not need a database; migrate/deploy do.
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://invalid:invalid@localhost:5432/invalid" },
});
