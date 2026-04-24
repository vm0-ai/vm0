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
  insertTestChatMessage,
  setTestChatMessageAttachFiles,
  setTestChatMessageContent,
} from "../../../../../../src/__tests__/api-test-helpers";
import { getTestZeroAgentId } from "../../../../../../src/__tests__/db-test-assertions/agents";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
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
  const data = (await response.json()) as { runId: string; threadId: string };
  // insertChatMessage is deferred into after() — drain so subsequent sends
  // see the user message row when building the incomplete-rounds context.
  await context.mocks.flushAfter();
  return data;
}

/**
 * Seed a prior round directly in the DB: one agent_runs row with the
 * requested status + one user chat_messages row linked by runId. Bypasses
 * the POST + deferred dispatch pipeline so tests that need many historical
 * rounds in a thread don't pay the per-round dispatch cost. The FINAL send
 * that reads the incomplete-rounds context still goes through the real
 * route handler.
 */
async function seedPriorRound(params: {
  userId: string;
  agentComposeId: string;
  chatThreadId: string;
  prompt: string;
  status?: string;
}): Promise<{ runId: string }> {
  const { runId } = await seedTestRun(params.userId, params.agentComposeId, {
    status: params.status ?? "cancelled",
    prompt: params.prompt,
    chatThreadId: params.chatThreadId,
    triggerSource: "web",
  });
  await insertTestChatMessage({
    chatThreadId: params.chatThreadId,
    userId: params.userId,
    role: "user",
    content: params.prompt,
    runId,
  });
  return { runId };
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
    // First round goes through the real route to establish the thread.
    const first = await sendMessage({ agentId, prompt: "seed-0" });
    await setTestRunStatus(first.runId, "cancelled");

    // Seed the remaining 24 cancelled rounds directly — skipping the POST +
    // deferred dispatch on each keeps the loop well under the 5s timeout in CI.
    for (let i = 1; i < 25; i++) {
      await seedPriorRound({
        userId: user.userId,
        agentComposeId: agentId,
        chatThreadId: first.threadId,
        prompt: `seed-${i}`,
      });
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

  it("handles a long thread (≥100 messages) without scanning all of history", async () => {
    // Seed 50 successive non-cancelled rounds so the thread is well past the
    // PREVIOUS_CONTEXT_MESSAGES bound and past the incomplete-rounds 20-cap.
    // The old `getMessagesByThreadId` scan + JS filter would read every row
    // on every send; under the bounded rewrite this send must still succeed
    // in reasonable time. Loop rounds are seeded directly (status=pending, not
    // 'cancelled'/'failed'/'timeout') so they don't pay the POST + dispatch
    // cost and still satisfy the assertion that no incomplete block appears.
    const first = await sendMessage({ agentId, prompt: "round 0" });
    for (let i = 1; i < 50; i++) {
      await seedPriorRound({
        userId: user.userId,
        agentComposeId: agentId,
        chatThreadId: first.threadId,
        prompt: `round ${i}`,
        status: "pending",
      });
    }

    const final = await sendMessage({
      agentId,
      prompt: "final",
      threadId: first.threadId,
    });

    const run = await getTestRun(final.runId);
    // None of the old rounds were cancelled, so the incomplete-rounds block
    // must not appear — this also confirms the anchor subquery correctly
    // returns no candidates when every run in the thread is healthy.
    expect(run.appendSystemPrompt ?? "").not.toContain(
      "# Incomplete Rounds Context",
    );
  });

  it("anchors incomplete rounds correctly on a long thread with a mid-thread success", async () => {
    // Pre-success tail: 30+ cancelled rounds the anchor must exclude.
    // First round goes through the real route to establish the thread; the
    // remaining pre-success cancels are seeded directly to avoid paying the
    // POST + dispatch cost 30 times over.
    const first = await sendMessage({ agentId, prompt: "early fail" });
    await setTestRunStatus(first.runId, "cancelled");

    for (let i = 0; i < 30; i++) {
      await seedPriorRound({
        userId: user.userId,
        agentComposeId: agentId,
        chatThreadId: first.threadId,
        prompt: `pre-success ${i}`,
      });
    }

    // Mid-thread success — stamps `agentSessionId` onto agent_runs.result,
    // which is what the SQL anchor subquery keys off.
    const success = await sendMessage({
      agentId,
      prompt: "success run",
      threadId: first.threadId,
    });
    const { agentSessionId } = await completeTestRun(
      user.userId,
      success.runId,
    );
    await setTestRunResult(success.runId, { agentSessionId });

    // Post-success incomplete round — must appear in incompleteContext.
    const afterSuccess = await sendMessage({
      agentId,
      prompt: "post-success cancel",
      threadId: first.threadId,
    });
    await setTestRunStatus(afterSuccess.runId, "cancelled");

    const next = await sendMessage({
      agentId,
      prompt: "final",
      threadId: first.threadId,
    });

    const run = await getTestRun(next.runId);
    const prompt = run.appendSystemPrompt ?? "";
    // Rounds after the anchor survive; rounds before it are dropped even
    // though the thread has 30+ of them just upstream of the success.
    expect(prompt).toContain("User: post-success cancel");
    expect(prompt).not.toContain("User: pre-success 0");
    expect(prompt).not.toContain("User: pre-success 29");
    expect(prompt).not.toContain("User: early fail");
  });
});
