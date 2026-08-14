import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  measureRunMetadataBridgeTargetUpdates,
  readPairedRunAutonomyBudgets,
  setRunAutonomyBudgetFixture,
  verifyRunMetadataTargetFailureRollback,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);

test("normalizes metadata and preserves compatibility-writer transaction semantics", async () => {
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Expected the metadata writer actor to have an org");
  }
  await seedOrgMetadata({ orgId: actor.orgId, tier: "pro", credits: 20_000 });
  bdd.acceptAgentStorageWrites();
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();

  const agentName = `metadata-writer-${randomUUID().slice(0, 8)}`;
  const compose = await api.createCompose(actor, {
    version: "1.0",
    agents: {
      [agentName]: {
        framework: "claude-code",
        environment: { ANTHROPIC_API_KEY: "metadata-writer-test-key" },
      },
    },
  });
  const run = await api.createDirectRun(actor, {
    agentComposeId: compose.composeId,
    prompt: "verify paired metadata writes",
  });

  await expect(
    readPairedRunAutonomyBudgets(context, run.runId),
  ).resolves.toStrictEqual({ zeroRun: 10, agentRun: 10 });

  await setRunAutonomyBudgetFixture(context, run.runId, 4, {
    disableBridge: true,
  });

  await expect(
    readPairedRunAutonomyBudgets(context, run.runId),
  ).resolves.toStrictEqual({ zeroRun: 4, agentRun: 4 });

  await expect(
    measureRunMetadataBridgeTargetUpdates(context, run.runId, 5),
  ).resolves.toBe(1);
  await expect(
    readPairedRunAutonomyBudgets(context, run.runId),
  ).resolves.toStrictEqual({ zeroRun: 5, agentRun: 5 });

  await expect(
    verifyRunMetadataTargetFailureRollback(context, run.runId, 6),
  ).resolves.toStrictEqual({
    targetWriteFailed: true,
    errorCode: "55P03",
    zeroRun: 5,
    agentRun: 5,
  });
});
