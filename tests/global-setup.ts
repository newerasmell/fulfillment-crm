import "dotenv/config";
import type { TestProject } from "vitest/node";
import { createTestDatabase } from "./test-db";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const db = await createTestDatabase();
  project.provide("databaseUrl", db.url);
  return async () => {
    await db.drop();
  };
}
