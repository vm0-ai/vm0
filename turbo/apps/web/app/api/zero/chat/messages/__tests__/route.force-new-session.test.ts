import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  enableModelFirstModelProviderForUser,
  insertOrgDefaultModelProvider,
  insertOrgModelPolicy,
  insertUserModelPreference,
  setOrgCredits,
  setTestRunStatus,
  getTestRun,
  findTestZeroRun,
  completeTestRun,
} from "../../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import { getTestChatThreadModelOverride } from "../../../../../../src/__tests__/db-test-assertions/org";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

const URL = "http://localhost:3000/api/zero/chat/messages";
const MODEL_FIRST_SENTINEL = "00000000-0000-4000-8000-000000000000";

const context = testContext();

async function postChat(body: Record<string, unknown>) {
  return POST(
    createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/zero/chat/messages — forceNewSession (model-first)", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-fns"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
    await enableModelFirstModelProviderForUser(user.orgId, user.userId);
    await setOrgCredits(user.orgId, 10_000);
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "claude-opus-4-7",
      isDefault: true,
    });
    await insertOrgModelPolicy({
      orgId: user.orgId,
      model: "claude-sonnet-4-6",
    });
  });

  it("rewrites the thread pin and starts a fresh session when forceNewSession is set", async () => {
    await insertUserModelPreference({
      orgId: user.orgId,
      userId: user.userId,
      model: "claude-opus-4-7",
    });

    const first = await postChat({ agentId, prompt: "first on opus" });
    expect(first.status).toBe(201);
    const { threadId, runId } = await first.json();
    await context.mocks.flushAfter();
    await completeTestRun(user.userId, runId);

    const initialPin = await getTestChatThreadModelOverride(threadId);
    expect(initialPin.selectedModel).toBe("claude-opus-4-7");

    const second = await postChat({
      agentId,
      prompt: "switch to sonnet",
      threadId,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SENTINEL,
        selectedModel: "claude-sonnet-4-6",
      },
      forceNewSession: true,
    });
    expect(second.status).toBe(201);
    const { runId: secondRunId } = await second.json();
    await context.mocks.flushAfter();

    const secondPin = await getTestChatThreadModelOverride(threadId);
    expect(secondPin.selectedModel).toBe("claude-sonnet-4-6");

    const secondRun = await findTestZeroRun(secondRunId);
    expect(secondRun?.selectedModel).toBe("claude-sonnet-4-6");
  });

  it("injects prior chat messages into appendSystemPrompt when forcing a new session", async () => {
    await insertUserModelPreference({
      orgId: user.orgId,
      userId: user.userId,
      model: "claude-opus-4-7",
    });

    const first = await postChat({ agentId, prompt: "hello on opus" });
    expect(first.status).toBe(201);
    const { threadId, runId } = await first.json();
    await context.mocks.flushAfter();
    await completeTestRun(user.userId, runId);

    const second = await postChat({
      agentId,
      prompt: "now on sonnet",
      threadId,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SENTINEL,
        selectedModel: "claude-sonnet-4-6",
      },
      forceNewSession: true,
    });
    expect(second.status).toBe(201);
    const { runId: secondRunId } = await second.json();
    await context.mocks.flushAfter();

    const run = await getTestRun(secondRunId);
    const prompt = run.appendSystemPrompt ?? "";
    expect(prompt).toContain("# Prior Chat Thread Context");
    expect(prompt).toContain("User: hello on opus");
    expect(prompt).toContain("RELATIVE_INDEX: 0");
  });

  it("suppresses the incomplete-rounds context block when forcing a new session", async () => {
    await insertUserModelPreference({
      orgId: user.orgId,
      userId: user.userId,
      model: "claude-opus-4-7",
    });

    const first = await postChat({ agentId, prompt: "round A" });
    expect(first.status).toBe(201);
    const { threadId, runId } = await first.json();
    await context.mocks.flushAfter();
    await setTestRunStatus(runId, "cancelled");

    const second = await postChat({
      agentId,
      prompt: "switch to sonnet after cancel",
      threadId,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SENTINEL,
        selectedModel: "claude-sonnet-4-6",
      },
      forceNewSession: true,
    });
    expect(second.status).toBe(201);
    const { runId: secondRunId } = await second.json();
    await context.mocks.flushAfter();

    const run = await getTestRun(secondRunId);
    const prompt = run.appendSystemPrompt ?? "";
    expect(prompt).not.toContain("# Incomplete Rounds Context");
    // The cancelled round's user text still surfaces via the prior-messages
    // block — replaying it as an incomplete round under a different model
    // would be misleading, but the agent still needs to see what was said.
    expect(prompt).toContain("# Prior Chat Thread Context");
    expect(prompt).toContain("User: round A");
  });

  it("still rejects a model change on an existing thread without forceNewSession", async () => {
    await insertUserModelPreference({
      orgId: user.orgId,
      userId: user.userId,
      model: "claude-opus-4-7",
    });

    const first = await postChat({ agentId, prompt: "first on opus" });
    expect(first.status).toBe(201);
    const { threadId, runId } = await first.json();
    await context.mocks.flushAfter();
    await completeTestRun(user.userId, runId);

    const second = await postChat({
      agentId,
      prompt: "switch to sonnet without flag",
      threadId,
      modelSelection: {
        modelProviderId: MODEL_FIRST_SENTINEL,
        selectedModel: "claude-sonnet-4-6",
      },
    });
    expect(second.status).toBe(400);
    const data = await second.json();
    expect(data.error.code).toBe("BAD_REQUEST");
  });
});
