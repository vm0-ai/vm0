import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cronAggregateInsightsContract,
  cronAggregateModelStatsContract,
  cronAggregateUsageContract,
  cronBrowserReconcileContract,
  cronCompactChatThreadSnapshotsContract,
  cronCompactUsageEventsContract,
  cronCleanupSandboxesContract,
  cronConnectorCatalogContract,
  cronConnectorOauthStateCleanupContract,
  cronComputerUseScreenshotCleanupContract,
  cronDrainEmailOutboxContract,
  cronExecuteMorningBriefsContract,
  cronExecuteWorkflowAutomationsContract,
  cronMonitorChatEventQueueContract,
  cronProcessUsageEventsContract,
  cronRenewGoogleCalendarWatchesContract,
  cronRenewGmailWatchesContract,
  cronRenewGoogleWorkspaceEventSubscriptionsContract,
  cronReconcileBillingEntitlementsContract,
  cronRefreshStoragePresignedUrlsContract,
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
    path: cronMonitorChatEventQueueContract.monitor.path,
    schedule: "* * * * *",
  },
  {
    path: cronExecuteWorkflowAutomationsContract.execute.path,
    schedule: "* * * * *",
  },
  {
    path: cronExecuteMorningBriefsContract.execute.path,
    schedule: "* * * * *",
  },
  {
    path: cronRenewGmailWatchesContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronRenewGoogleCalendarWatchesContract.renew.path,
    schedule: "0 */12 * * *",
  },
  {
    path: cronRenewGoogleWorkspaceEventSubscriptionsContract.renew.path,
    schedule: "0 */12 * * *",
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
    path: cronCompactChatThreadSnapshotsContract.compact.path,
    schedule: "0 * * * *",
  },
  {
    path: cronCompactUsageEventsContract.compact.path,
    schedule: "* * * * *",
  },
  {
    path: cronTelegramCleanupContract.cleanup.path,
    schedule: "0 1 * * *",
  },
  {
    path: cronConnectorOauthStateCleanupContract.cleanup.path,
    schedule: "15 * * * *",
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
    path: cronConnectorCatalogContract.sync.path,
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
    path: cronRefreshStoragePresignedUrlsContract.refresh.path,
    schedule: "* * * * *",
  },
  {
    path: cronComputerUseScreenshotCleanupContract.cleanup.path,
    schedule: "30 2 * * *",
  },
  {
    path: cronBrowserReconcileContract.reconcile.path,
    schedule: "* * * * *",
  },
  {
    path: cronAggregateModelStatsContract.aggregate.path,
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

  it("does not register the previous internal model stats cron path", () => {
    const routePaths = new Set(
      ROUTES.map(({ route }) => {
        return route.path;
      }),
    );

    expect(
      routePaths.has("/api/internal/cron/aggregate-model-stats"),
    ).toBeFalsy();
  });
});
