import { createStore } from "ccstate";
import { WebClient } from "@slack/web-api";
import type { TestSlackDispatchProbeResponse } from "@vm0/api-contracts/contracts/test-slack-dispatch-probe";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteSlackWebhookFixture$,
  seedSlackWebhookFixture$,
  type SlackWebhookFixture,
} from "./helpers/zero-slack-webhooks";

// BDD migration of the legacy
// `test-slack-dispatch-probe.test.ts`. The 8 legacy `it()`s
// collapse into 2 BDD `it()`s: (1) 404 + 400 chain (404
// outside allowed envs → 400 Vercel preview with internal
// bypass header → 400 preview with the schema-backed
// bypass secret → 400 protected preview rewrites after
// Vercel consumes bypass headers → 200 routes preview Slack
// Web API calls to API mock routes + WebClient called with
// the mock URL + bypass headers → 400 legacy missing-field
// error), (2) 200 dispatch chain (200 synchronously
// dispatches connected mention probes with DB run written
// → 200 synchronously dispatches connected direct-message
// probes with Slack status update called → 200 serializes
// synchronous dispatch errors as diagnostic 200 responses).
//
// Service-Level Exception: `vm0ApiKeys`, `agentRuns`, and
// `zeroRuns` rows are seeded + read directly via
// `writeDb$` because no public route creates them.

const context = testContext();
const store = createStore();
const ROUTE = "/api/test/slack-dispatch-probe";
const TEST_VM0_ANTHROPIC_KEY = "vm0-key-slack-dispatch-probe-claude-sonnet-4-6";
const TEST_VM0_DEEPSEEK_KEY = "vm0-key-slack-dispatch-probe-deepseek-v4-pro";

afterEach(async () => {
  const db = store.set(writeDb$);
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_ANTHROPIC_KEY));
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_DEEPSEEK_KEY));
});

async function seedVm0ManagedKeys(): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_ANTHROPIC_KEY));
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, TEST_VM0_DEEPSEEK_KEY));
  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: TEST_VM0_ANTHROPIC_KEY,
    },
    {
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: TEST_VM0_DEEPSEEK_KEY,
    },
  ]);
}

function configureSlackProbeTest(): void {
  mockEnv("ENV", "development");
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  mockEnv("VM0_WEB_URL", "https://www.vm0.test");
  mockEnv("APP_URL", "https://app.vm0.test");
  mockEnv("VM0_API_URL", "https://api.vm0.test");
  context.mocks.s3.send.mockResolvedValue({});
  context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
    ok: true,
  });
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000000",
    channel: "C-test",
  });
  context.mocks.slack.chat.postEphemeral.mockResolvedValue({
    ok: true,
    message_ts: "1710000000.000001",
  });
  context.mocks.slack.conversations.history.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.conversations.replies.mockResolvedValue({
    ok: true,
    messages: [],
  });
  context.mocks.slack.users.info.mockResolvedValue({
    ok: true,
    user: {
      profile: {
        display_name: "Slack User",
        email: "slack@example.com",
      },
      tz: "UTC",
    },
  });
}

function requestApp(path: string, init?: RequestInit): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(path, init));
}

function postProbe(body: unknown): Promise<Response> {
  return requestApp(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readSingleRunForUser(userId: string): Promise<{
  readonly id: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string | null;
}> {
  const db = store.set(writeDb$);
  const [run] = await db
    .select({
      id: agentRuns.id,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.userId, userId))
    .limit(1);
  if (!run) {
    throw new Error(`No run found for user ${userId}`);
  }
  return run;
}

async function readZeroRunTriggerSource(
  runId: string,
): Promise<string | null | undefined> {
  const db = store.set(writeDb$);
  const [zeroRun] = await db
    .select({ triggerSource: zeroRuns.triggerSource })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return zeroRun?.triggerSource;
}

describe("BDD POST /api/test/slack-dispatch-probe — 404 + 400 + 200 mock-routing chain", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(async () => {
    await seedVm0ManagedKeys();
    configureSlackProbeTest();
  });

  it("gwt-wt-wt: 404 outside allowed envs → 400 Vercel preview with internal bypass header → 400 preview with the schema-backed bypass secret → 400 protected preview rewrites after Vercel consumes bypass headers → 200 routes preview Slack Web API calls to API mock routes + WebClient called with the mock URL + bypass headers → 400 legacy missing-field error", async () => {
    // Given: production env.

    // When + Then: 404.
    mockEnv("ENV", "production");
    const prodResponse = await postProbe({});
    expect(prodResponse.status).toBe(404);
    await expect(prodResponse.text()).resolves.toBe("Not found");

    // Given: production env + Vercel preview + bypass secret.
    mockEnv("ENV", "production");
    mockOptionalEnv("VERCEL_ENV", "preview");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    // When + Then: 400 — missing-field error.
    const previewResponse = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });
    expect(previewResponse.status).toBe(400);
    await expect(previewResponse.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });

    // Given: preview env + schema-backed bypass secret.
    mockEnv("ENV", "preview");
    mockEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    // When + Then: 400 — missing-field error.
    const previewBypassResponse = await requestApp(ROUTE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      body: JSON.stringify({}),
    });
    expect(previewBypassResponse.status).toBe(400);
    await expect(previewBypassResponse.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });

    // Given: protected preview rewrites after Vercel
    // consumes bypass headers.
    mockEnv("ENV", "preview");
    mockOptionalEnv("USE_MOCK_CLAUDE", "true");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");

    // When + Then: 400.
    const protectedPreviewResponse = await postProbe({});
    expect(protectedPreviewResponse.status).toBe(400);
    await expect(protectedPreviewResponse.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });

    // Given: the slack-mock env + a fresh Slack webhook
    // fixture.
    mockOptionalEnv("E2E_SLACK_MOCK_ENABLED", "1");
    mockOptionalEnv("VERCEL_URL", "pr-13948-api.vm6.ai");
    mockOptionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "preview-secret");
    const mockFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    // When + Then: 200 — WebClient is called with the mock
    // URL + bypass headers.
    const mockResponse = await postProbe({
      team_id: mockFixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: mockFixture.slackUserId,
      message_text: "mock Slack API",
      message_ts: "1710000003.000000",
    });
    expect(mockResponse.status).toBe(200);
    expect(WebClient).toHaveBeenCalledWith(expect.any(String), {
      slackApiUrl: "https://pr-13948-api.vm6.ai/api/test/slack-mock/",
      headers: {
        "x-vercel-protection-bypass": "preview-secret",
        "x-vm0-test-endpoint-bypass": "preview-secret",
      },
      retryConfig: { retries: 1 },
      timeout: 5000,
    });

    // Given: a partial request payload missing most fields.
    // When + Then: 400 — legacy missing-field error.
    const missingFieldsResponse = await postProbe({
      team_id: "T-test",
      channel_id: "C-test",
    });
    expect(missingFieldsResponse.status).toBe(400);
    await expect(missingFieldsResponse.json()).resolves.toStrictEqual({
      error: "team_id, channel_id, user_id, message_text, message_ts required",
    });
  });
});

describe("BDD POST /api/test/slack-dispatch-probe — 200 dispatch chain", () => {
  const track = createFixtureTracker<SlackWebhookFixture>((fixture) => {
    return store.set(deleteSlackWebhookFixture$, fixture, context.signal);
  });

  beforeEach(async () => {
    await seedVm0ManagedKeys();
    configureSlackProbeTest();
  });

  it("gwt-wt-wt: 200 synchronously dispatches connected mention probes with DB run written → 200 synchronously dispatches connected direct-message probes with Slack status update called → 200 serializes synchronous dispatch errors as diagnostic 200 responses", async () => {
    // Given: a fresh Slack webhook fixture.
    const mentionFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    // When: dispatch a connected mention probe.
    const mentionResponse = await postProbe({
      team_id: mentionFixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: mentionFixture.slackUserId,
      message_text: "summarize this channel",
      message_ts: "1710000000.000000",
      channel_type: "channel",
    });

    // Then: 200 + a run was written to the DB with the
    // expected prompt + appendSystemPrompt + zero-run
    // trigger source.
    expect(mentionResponse.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(mentionResponse),
    ).resolves.toStrictEqual({ ok: true });
    const mentionRun = await readSingleRunForUser(mentionFixture.userId);
    expect(mentionRun.prompt).toBe("summarize this channel");
    expect(mentionRun.appendSystemPrompt).toContain(
      "You are currently running inside: Slack",
    );
    expect(mentionRun.appendSystemPrompt).toContain("Channel type: Channel");
    await expect(readZeroRunTriggerSource(mentionRun.id)).resolves.toBe(
      "slack",
    );

    // Given: a fresh Slack webhook fixture.
    const dmFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );

    // When: dispatch a connected direct-message probe.
    const dmResponse = await postProbe({
      team_id: dmFixture.slackWorkspaceId,
      channel_id: "D-test",
      user_id: dmFixture.slackUserId,
      message_text: "hello in dm",
      message_ts: "1710000001.000000",
      channel_type: "im",
    });

    // Then: 200 + a run was written with the DM channel
    // type + Slack status update was called with the DM
    // channel id + thread ts.
    expect(dmResponse.status).toBe(200);
    await expect(
      readJson<TestSlackDispatchProbeResponse>(dmResponse),
    ).resolves.toStrictEqual({ ok: true });
    const dmRun = await readSingleRunForUser(dmFixture.userId);
    expect(dmRun.prompt).toBe("hello in dm");
    expect(dmRun.appendSystemPrompt).toContain("Channel type: Direct message");
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D-test",
        thread_ts: "1710000001.000000",
      }),
    );

    // Given: a fresh Slack webhook fixture + the Slack
    // status update mock rejects with a `slack_status_failed`
    // error.
    const errorFixture = await track(
      store.set(
        seedSlackWebhookFixture$,
        { withConnection: true, withDefaultAgent: true },
        context.signal,
      ),
    );
    const statusError = Object.assign(new Error("status update failed"), {
      code: "slack_status_failed",
    });
    context.mocks.slack.assistant.threads.setStatus.mockRejectedValueOnce(
      statusError,
    );

    // When: dispatch a probe that triggers the error.
    const errorResponse = await postProbe({
      team_id: errorFixture.slackWorkspaceId,
      channel_id: "C-test",
      user_id: errorFixture.slackUserId,
      message_text: "trigger an error",
      message_ts: "1710000002.000000",
    });

    // Then: 200 — synchronous dispatch errors are
    // serialized as diagnostic 200 responses.
    expect(errorResponse.status).toBe(200);
    const errorBody = await readJson<TestSlackDispatchProbeResponse>(
      errorResponse,
    );
    expect(errorBody).toMatchObject({
      ok: false,
      error: {
        name: "Error",
        message: "status update failed",
        code: "slack_status_failed",
      },
    });
  });
});
