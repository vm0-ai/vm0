import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface VercelCron {
  readonly path: string;
  readonly schedule: string;
}

interface VercelConfig {
  readonly crons?: readonly VercelCron[];
}

function readVercelConfig(): VercelConfig {
  const configPath = fileURLToPath(new URL("../vercel.json", import.meta.url));
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

describe("vercel cron config", () => {
  it("does not register cron jobs from the web deployment", () => {
    expect(readVercelConfig().crons ?? []).toStrictEqual([]);
  });
});
