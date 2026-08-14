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
  readRunMetadataPair,
  saveRunSummaryFixture,
  setRunAutonomyBudgetFixture,
} from "./helpers/runtime-state";

const context = testContext();
const bdd = createBddApi(context);
const api = createRunsApi(context);

test("normalizes metadata and writes only agent run metadata", async () => {
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
  expect(initialMetadata.agent_run).toStrictEqual({
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
  expect(initialMetadata.zero_run).toBeNull();

  await setRunAutonomyBudgetFixture(context, run.runId, 4);
  const updatedMetadata = await readRunMetadataPair(context, run.runId);
  expect(updatedMetadata.agent_run?.autonomy_budget).toBe(4);
  expect(updatedMetadata.zero_run).toBeNull();

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
  expect(summarizedMetadata.agent_run?.summary).toBe(generatedSummary);
  expect(summarizedMetadata.zero_run).toBeNull();

  generatedSummary = "Replacement metadata summary";
  await saveRunSummaryFixture(context, {
    runId: run.runId,
    triggerSource: "test",
    prompt: "replace the metadata summary",
    resultText: "the replacement completed",
  });
  summarizedMetadata = await readRunMetadataPair(context, run.runId);
  expect(summarizedMetadata.agent_run?.summary).toBe(generatedSummary);
  expect(summarizedMetadata.zero_run).toBeNull();
});
