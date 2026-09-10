import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default async function globalSetup(): Promise<void> {
  process.env.E2E_CLERK_RESOURCE_DIR ??= await mkdtemp(
    join(tmpdir(), "playwright-clerk-resources-"),
  );
  await mkdir(process.env.E2E_CLERK_RESOURCE_DIR, { recursive: true });
}
