import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  insertOrgDefaultModelProvider,
  getTestRun,
  setTestRunStatus,
  setTestRunResult,
  completeTestRun,
  insertTestAssistantEventMessages,
  setTestChatMessageAttachFiles,
  setTestChatMessageContent,
} from "../../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../src/__tests__/test-helpers";
import { reloadEnv } from "../../../../../../src/env";

const URL = "http://localhost:3000/api/zero/chat/messages";
const context = testContext();

async function sendMessage(body: Record<string, unknown>) {
  const response = await POST(
    createTestRequest(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{ runId: string; threadId: string }>;
}

describe("POST /api/zero/chat/messages — incomplete rounds context", () => {
  let user: UserContext;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("chat-ic"));
    agentId = await getTestZeroAgentId(user.orgId, compose.name);
    vi.stubEnv("RUNNER_DEFAULT_GROUP", "vm0/production");
    reloadEnv();
    await insertOrgDefaultModelProvider(user.orgId, "anthropic-api-key");
  });

  it("omits the incomplete context block when the thread has no cancelled/failed runs", async () => {
    const first = await sendMessage({
      agentId,
      prompt: "hello new thread",
    });

    const second = await sendMessage({
      agentId,
      prompt: "follow up",
      threadId: first.threadId,
    });

    const run = await getTestRun(second.runId);
    expect(run.appendSystemPrompt ?? "").not.toContain(
      "# Incomplete Rounds Context",
    );
  });

  it("injects a single cancelled round with a placeholder assistant line", async () => {
    const first = await sendMessage({
      agentId,
      prompt: "please cancel me",
    });

    await setTestRunStatus(first.runId, "cancelled");

    const second = await sendMessage({
      agentId,
      prompt: "next attempt",
      threadId: first.threadId,
    });

    const run = await getTestRun(second.runId);
    expect(run.appendSystemPrompt).toContain("# Incomplete Rounds Context");
    expect(run.appendSystemPrompt).toContain("RUN_STATUS: cancelled");
    expect(run.appendSystemPrompt).toContain("User: please cancel me");
    expect(run.appendSystemPrompt).toContain(
      "Assistant: [no response before run ended]",
    );
    expect(run.appendSystemPrompt).toContain("RELATIVE_INDEX: 0");
  });

  it("injects a failed round alongside its partial assistant text", async () => {
    const first = await sendMessage({
      agentId,
      prompt: "run that will fail",
    });

    await insertTestAssistantEventMessages(
      first.runId,
      first.threadId,
      user.userId,
      [
        {
          sequenceNumber: 1,
          content: "I was partway through answering",
        },
      ],
    );
    await setTestRunStatus(first.runId, "failed");

    const second = await sendMessage({
      agentId,
      prompt: "retry",
      threadId: first.threadId,
    });

    const run = await getTestRun(second.runId);
    expect(run.appendSystemPrompt).toContain("RUN_STATUS: failed");
    expect(run.appendSystemPrompt).toContain("User: run that will fail");
    expect(run.appendSystemPrompt).toContain(
      "Assistant (partial): I was partway through answering",
    );
  });

  it("orders multiple consecutive incomplete rounds with -N..0 relative indices", async () => {
    const first = await sendMessage({ agentId, prompt: "round A" });
    await setTestRunStatus(first.runId, "cancelled");

    const second = await sendMessage({
      agentId,
      prompt: "round B",
      threadId: first.threadId,
    });
    await setTestRunStatus(second.runId, "failed");

    const third = await sendMessage({
      agentId,
      prompt: "round C",
      threadId: first.threadId,
    });
    await setTestRunStatus(third.runId, "cancelled");

    const fourth = await sendMessage({
      agentId,
      prompt: "round D",
      threadId: first.threadId,
    });

    const run = await getTestRun(fourth.runId);
    const prompt = run.appendSystemPrompt ?? "";
    expect(prompt).toContain("RELATIVE_INDEX: -2");
    expect(prompt).toContain("RELATIVE_INDEX: -1");
    expect(prompt).toContain("RELATIVE_INDEX: 0");
    const aIdx = prompt.indexOf("User: round A");
    const bIdx = prompt.indexOf("User: round B");
    const cIdx = prompt.indexOf("User: round C");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
    // The in-flight round (D) is NOT in the historical context.
    expect(prompt).not.toContain("User: round D");
  });

  it("excludes incomplete rounds that happened before the last run with an agentSessionId", async () => {
    const beforeSuccess = await sendMessage({ agentId, prompt: "early fail" });
    await setTestRunStatus(beforeSuccess.runId, "cancelled");

    const success = await sendMessage({
      agentId,
      prompt: "success run",
      threadId: beforeSuccess.threadId,
    });
    const { agentSessionId } = await completeTestRun(
      user.userId,
      success.runId,
    );
    // completeTestRun sets status=completed but leaves result null; stamping
    // agentSessionId onto result is what getLatestSessionIdForThread reads.
    await setTestRunResult(success.runId, { agentSessionId });

    const afterSuccess = await sendMessage({
      agentId,
      prompt: "post-success cancel",
      threadId: beforeSuccess.threadId,
    });
    await setTestRunStatus(afterSuccess.runId, "cancelled");

    const next = await sendMessage({
      agentId,
      prompt: "retry after partial failure",
      threadId: beforeSuccess.threadId,
    });

    const run = await getTestRun(next.runId);
    const prompt = run.appendSystemPrompt ?? "";
    expect(prompt).toContain("User: post-success cancel");
    expect(prompt).not.toContain("User: early fail");
  });

  it("renders attachments under the cancelled user message", async () => {
    const first = await sendMessage({
      agentId,
      prompt: "look at these",
      attachFiles: [
        {
          id: "attach-uuid-1",
          filename: "doc.pdf",
          contentType: "application/pdf",
          size: 1024,
        },
      ],
    });
    await setTestRunStatus(first.runId, "cancelled");
    await setTestChatMessageAttachFiles(first.runId, ["attach-uuid-1"]);

    const second = await sendMessage({
      agentId,
      prompt: "retry",
      threadId: first.threadId,
    });

    const run = await getTestRun(second.runId);
    expect(run.appendSystemPrompt).toContain("User: look at these");
    expect(run.appendSystemPrompt).toContain("[ID] attach-uuid-1");
  });

  it("caps at 20 most-recent incomplete rounds when more exist", async () => {
    const first = await sendMessage({ agentId, prompt: "seed-0" });
    await setTestRunStatus(first.runId, "cancelled");

    for (let i = 1; i < 25; i++) {
      const sent = await sendMessage({
        agentId,
        prompt: `seed-${i}`,
        threadId: first.threadId,
      });
      await setTestRunStatus(sent.runId, "cancelled");
    }

    const next = await sendMessage({
      agentId,
      prompt: "final",
      threadId: first.threadId,
    });

    const run = await getTestRun(next.runId);
    const prompt = run.appendSystemPrompt ?? "";
    // Most recent 20 rounds (seed-5 through seed-24) are kept; earliest 5 are dropped.
    expect(prompt).not.toContain("User: seed-0");
    expect(prompt).not.toContain("User: seed-4");
    expect(prompt).toContain("User: seed-5");
    expect(prompt).toContain("User: seed-24");
  });

  it("truncates overlong user content with an …[truncated] suffix", async () => {
    const first = await sendMessage({ agentId, prompt: "placeholder" });
    await setTestRunStatus(first.runId, "cancelled");

    const longContent = "x".repeat(5000);
    await setTestChatMessageContent(first.runId, longContent);

    const second = await sendMessage({
      agentId,
      prompt: "continue",
      threadId: first.threadId,
    });

    const run = await getTestRun(second.runId);
    const prompt = run.appendSystemPrompt ?? "";
    expect(prompt).toContain("…[truncated]");
    expect(prompt).not.toContain("x".repeat(5000));
  });
});
