import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cronAggregateInsightsContract,
  cronAggregateUsageContract,
  cronCleanupSandboxesContract,
  cronComputerUseScreenshotCleanupContract,
  cronDrainEmailOutboxContract,
  cronExecuteSchedulesContract,
  cronProcessUsageEventsContract,
  cronReconcileBillingEntitlementsContract,
  cronSyncSkillsContract,
  cronTelegramCleanupContract,
} from "@vm0/api-contracts/contracts/cron";
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

const expectedVercelCrons = [
  {
    path: cronCleanupSandboxesContract.cleanup.path,
    schedule: "* * * * *",
  },
  {
    path: cronExecuteSchedulesContract.execute.path,
    schedule: "* * * * *",
  },
  {
    path: cronAggregateUsageContract.aggregate.path,
    schedule: "5 0 * * *",
  },
  {
    path: cronAggregateInsightsContract.aggregate.path,
    schedule: "0 * * * *",
  },
  {
    path: cronTelegramCleanupContract.cleanup.path,
    schedule: "0 1 * * *",
  },
  {
    path: cronDrainEmailOutboxContract.drain.path,
    schedule: "* * * * *",
  },
  {
    path: cronSyncSkillsContract.sync.path,
    schedule: "* * * * *",
  },
  {
    path: cronProcessUsageEventsContract.process.path,
    schedule: "* * * * *",
  },
  {
    path: cronReconcileBillingEntitlementsContract.reconcile.path,
    schedule: "0 0,12 * * *",
  },
  {
    path: cronComputerUseScreenshotCleanupContract.cleanup.path,
    schedule: "30 2 * * *",
  },
  {
    path: "/api/internal/cron/aggregate-model-stats",
    schedule: "12 * * * *",
  },
] satisfies readonly VercelCron[];

describe("vercel cron config", () => {
  it("matches API-owned cron schedules", () => {
    const crons = readVercelConfig().crons ?? [];

    expect(crons).toStrictEqual(expectedVercelCrons);
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
