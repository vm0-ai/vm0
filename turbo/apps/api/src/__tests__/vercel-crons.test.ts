import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { cronComputerUseScreenshotCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../signals/route";

interface VercelCron {
  readonly path: string;
  readonly schedule: string;
}

interface VercelConfig {
  readonly crons?: readonly VercelCron[];
}

function readVercelConfig(): VercelConfig {
  const configPath = fileURLToPath(
    new URL("../../vercel.json", import.meta.url),
  );
  return JSON.parse(readFileSync(configPath, "utf8")) as VercelConfig;
}

describe("vercel cron config", () => {
  it("schedules computer-use screenshot cleanup", () => {
    const crons = readVercelConfig().crons ?? [];

    expect(crons).toContainEqual({
      path: cronComputerUseScreenshotCleanupContract.cleanup.path,
      schedule: "30 2 * * *",
    });
  });

  it("targets existing API routes without duplicate paths", () => {
    const crons = readVercelConfig().crons ?? [];
    const routePaths = new Set(
      ROUTES.map(({ route }) => {
        return route.path;
      }),
    );
    const cronPaths = crons.map(({ path }) => {
      return path;
    });

    expect(new Set(cronPaths).size).toBe(cronPaths.length);
    for (const path of cronPaths) {
      expect(
        routePaths.has(path),
        `${path} must be registered in API routes`,
      ).toBeTruthy();
    }
  });
});
