import { closeDbPool } from "../lib/db";

export async function closeFixtureDbPool(): Promise<void> {
  await closeDbPool();
}
