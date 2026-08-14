import { randomUUID } from "node:crypto";

import { DEFAULT_VIDEO_MODEL } from "@okouai/core/video-model-catalog";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  measureRunMetadataBridgeTargetUpdates,
  readPairedRunAutonomyBudgets,
  readRunMetadataPair,
  saveRunSummaryFixture,
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

  const initialMetadata = await readRunMetadataPair(context, run.runId);
  expect(initialMetadata.agent_run).toStrictEqual(initialMetadata.zero_run);
  expect(initialMetadata.zero_run).toStrictEqual({
    trigger_source: "test",
    autonomy_budget: 10,
    workflow_automation_id: null,
    goal_id: null,
    model_provider: null,
    model_provider_id: null,
    model_provider_credential_scope: null,
    selected_model: null,
    codex_service_tier: null,
    selected_video_model: DEFAULT_VIDEO_MODEL,
    chat_thread_id: null,
    api_started_at: expect.any(String),
    first_assistant_event_acknowledged_at: null,
    summary: null,
    trigger_brief: null,
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

  mockOptionalEnv("OPENROUTER_API_KEY", "metadata-summary-key");
  let generatedSummary = "Initial metadata summary";
  server.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () => {
      return HttpResponse.json({
        choices: [{ message: { content: generatedSummary } }],
      });
    }),
  );
  await saveRunSummaryFixture(context, {
    runId: run.runId,
    triggerSource: "test",
    prompt: "summarize the metadata writer",
    resultText: "the metadata writer completed",
  });
  let summarizedMetadata = await readRunMetadataPair(context, run.runId);
  expect(summarizedMetadata.agent_run).toStrictEqual(
    summarizedMetadata.zero_run,
  );
  expect(summarizedMetadata.zero_run?.summary).toBe(generatedSummary);

  generatedSummary = "Replacement metadata summary";
  await saveRunSummaryFixture(context, {
    runId: run.runId,
    triggerSource: "test",
    prompt: "replace the metadata summary",
    resultText: "the replacement completed",
  });
  summarizedMetadata = await readRunMetadataPair(context, run.runId);
  expect(summarizedMetadata.agent_run).toStrictEqual(
    summarizedMetadata.zero_run,
  );
  expect(summarizedMetadata.zero_run?.summary).toBe(generatedSummary);
});
