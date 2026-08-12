import { beforeEach, describe, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import { cronCleanupSandboxesRoutes } from "../cron-cleanup-sandboxes";
import { cronConnectorOauthStateCleanupRoutes } from "../cron-connector-oauth-state-cleanup";
import { cronDrainEmailOutboxRoutes } from "../cron-drain-email-outbox";
import { cronExecuteWorkflowAutomationsRoutes } from "../cron-execute-workflow-automations";
import { modelStatsRoutes } from "../model-stats";
import { cronReconcileBillingEntitlementsRoutes } from "../cron-reconcile-billing-entitlements";
import { cronSyncSkillsRoutes } from "../cron-sync-skills";
import {
  expectGlobalSweepMissingAuth,
  expectGlobalSweepRemovedInputRejected,
  expectGlobalSweepWrongAuth,
} from "./helpers/global-sweep-contract";

const context = testContext();
const CRON_SECRET = "test-cron-secret";

describe("production-global sweep route contracts", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", CRON_SECRET);
  });

  it("rejects cleanup-sandboxes requests with an invalid cron secret", async () => {
    await expectGlobalSweepWrongAuth(
      context,
      cronCleanupSandboxesRoutes,
      "/api/cron/cleanup-sandboxes",
    );
  });

  it("rejects cleanup-sandboxes requests without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronCleanupSandboxesRoutes,
      "/api/cron/cleanup-sandboxes",
    );
  });

  it("rejects connector OAuth cleanup requests without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronConnectorOauthStateCleanupRoutes,
      "/api/cron/connector-oauth-state-cleanup",
    );
  });

  it("rejects billing reconciliation requests without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronReconcileBillingEntitlementsRoutes,
      "/api/cron/reconcile-billing-entitlements",
    );
  });

  it("rejects email-outbox drain requests without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronDrainEmailOutboxRoutes,
      "/api/cron/drain-email-outbox",
    );
  });

  it("rejects sync-skills requests with an invalid cron secret", async () => {
    await expectGlobalSweepWrongAuth(
      context,
      cronSyncSkillsRoutes,
      "/api/cron/sync-skills",
    );
  });

  it("rejects sync-skills requests without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronSyncSkillsRoutes,
      "/api/cron/sync-skills",
    );
  });

  it("rejects workflow automation sweeps without authorization", async () => {
    await expectGlobalSweepMissingAuth(
      context,
      cronExecuteWorkflowAutomationsRoutes,
      "/api/cron/execute-workflow-automations",
    );
  });

  it("rejects model-stats aggregation with an invalid cron secret", async () => {
    await expectGlobalSweepWrongAuth(
      context,
      modelStatsRoutes,
      "/api/cron/aggregate-model-stats",
    );
  });

  it("rejects the removed model-stats rebuild-window input", async () => {
    await expectGlobalSweepRemovedInputRejected(
      context,
      modelStatsRoutes,
      "/api/cron/aggregate-model-stats?hours=24",
    );
  });
});
