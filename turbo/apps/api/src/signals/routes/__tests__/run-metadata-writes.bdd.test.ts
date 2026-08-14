import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  readPairedRunAutonomyBudgets,
  setRunAutonomyBudgetFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);

test("normalizes the run autonomy default and writes it without the database bridge", async () => {
  const actor = bdd.user();
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
});
