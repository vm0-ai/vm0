import { describe, it, expect, vi } from "vitest";
import { HttpResponse } from "msw";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { createTestCompose } from "../../../../__tests__/api-test-helpers";
import {
  appendTestVoiceChatItem,
  insertTestVoiceChatTask,
  insertTestVoiceChatSession,
  seedTestVoiceChatSession,
  simulateConcurrentVoiceChatSessionWrite,
} from "../../../../__tests__/db-test-seeders/voice-chat";
import {
  getTestVoiceChatTask,
  getTestVoiceChatSessionReasoningState,
  listTestVoiceChatTasks,
  readTestVoiceChatItems,
} from "../../../../__tests__/db-test-assertions/voice-chat";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import { mockAblyPublish } from "../../../../__tests__/ably-mock";
import { reloadEnv } from "../../../../env";
import { triggerReasoning } from "../trigger-reasoning";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const context = testContext();

function openRouterResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

function threeSectionPayload(parts: {
  conversation?: string;
  working?: string;
  finished?: string;
}): string {
  return [
    "---CONVERSATION---",
    parts.conversation ?? "",
    "---WORKING---",
    parts.working ?? "",
    "---FINISHED---",
    parts.finished ?? "",
  ].join("\n");
}

function missingTasksPayload(parts: {
  conversation?: string;
  missingTasks?: string[];
}): string {
  const sections = ["---CONVERSATION---", parts.conversation ?? ""];
  if (parts.missingTasks && parts.missingTasks.length > 0) {
    sections.push("---MISSING_TASKS---", parts.missingTasks.join("\n"));
  }
  return sections.join("\n");
}

async function seedActiveSession(): Promise<{
  userId: string;
  orgId: string;
  sessionId: string;
}> {
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-reasoner"),
  });
  const sessionId = await seedTestVoiceChatSession({
    userId,
    orgId,
    agentId: composeId,
  });
  return { userId, orgId, sessionId };
}

describe("triggerReasoning", () => {
  it("H1 — writes 3 summaries, bumps seq/version, and publishes on success", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "hello",
      realtimeItemId: uniqueId("rt"),
    });
    const b = await appendTestVoiceChatItem({
      sessionId,
      role: "assistant",
      content: "hi there",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse(
          threeSectionPayload({
            conversation: "Focus: greeting",
            working: "",
            finished: "",
          }),
        ),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBe("Focus: greeting");
    // workingTasksSummary and finishedTasksSummary are no longer written —
    // the Talker's Task board reads live state from the tasks table.
    expect(row?.workingTasksSummary).toBeNull();
    expect(row?.finishedTasksSummary).toBeNull();
    expect(row?.summarySeq).toBe(b!.seq);
    expect(row?.summaryVersion).toBe(1);
    expect(row?.reasoningStatus).toBe("idle");
    expect(row?.reasoningPending).toBe(false);
    expect(row?.lastSummaryAt).not.toBeNull();
    expect(handler.mocked).toHaveBeenCalledTimes(1);

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat:${sessionId}`,
      null,
    );
  });

  it("H2 — appends system_note and does not publish when the reasoner returns null", async () => {
    context.setupMocks();
    // OPENROUTER_API_KEY is intentionally absent — callReasoner short-circuits
    // to null, which is exactly the "reasoner failed" branch we want to cover.
    const { sessionId } = await seedActiveSession();
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "anything",
      realtimeItemId: uniqueId("rt"),
    });

    await triggerReasoning(sessionId);

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBeNull();
    expect(row?.summaryVersion).toBe(0);
    expect(row?.reasoningStatus).toBe("idle");
    // lastSummaryAt is bumped on both success and failure branches so
    // operators can distinguish "ticks running but failing" from "no tick ran".
    expect(row?.lastSummaryAt).not.toBeNull();

    const items = await readTestVoiceChatItems(sessionId);
    const systemNotes = items.filter((i) => {
      return i.role === "system_note";
    });
    expect(systemNotes).toHaveLength(1);
    expect(systemNotes[0]!.content).toBe("Reasoner tick failed");

    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("H3 — concurrent triggers run the reasoner once and drain the pending flag", async () => {
    const mocks = context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "concurrent",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse(threeSectionPayload({ conversation: "ctx" })),
      );
    });
    server.use(handler.handler);

    await Promise.all([
      triggerReasoning(sessionId),
      triggerReasoning(sessionId),
    ]);

    // The second trigger set reasoning_pending; the first must have drained it
    // and scheduled an after() re-tick. Flush the queue so the drain fires.
    await mocks.flushAfter();

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.reasoningStatus).toBe("idle");
    expect(row?.reasoningPending).toBe(false);
    expect(row?.summaryVersion).toBe(1);
    // Exactly one OpenRouter call — the drain re-tick sees no new items and
    // takes the debounce bailout (Decision H6).
    expect(handler.mocked).toHaveBeenCalledTimes(1);
    expect(mockAblyPublish).toHaveBeenCalledTimes(1);
  });

  it("H4 — a concurrent summaryVersion bump causes the write to drop silently", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "racy",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, async () => {
      // Simulate another tick winning the write race between our snapshot
      // and our optimistic UPDATE.
      await simulateConcurrentVoiceChatSessionWrite(
        sessionId,
        99,
        "written by another tick",
      );
      return HttpResponse.json(
        openRouterResponse(
          threeSectionPayload({ conversation: "stale context" }),
        ),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBe("written by another tick");
    expect(row?.summaryVersion).toBe(99);
    expect(row?.reasoningStatus).toBe("idle");
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("H5 — runs successfully when the session has no associated agent", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { userId, orgId } = await context.setupUser();
    const sessionId = await insertTestVoiceChatSession({
      userId,
      orgId,
      agentId: null,
    });
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "sans-agent",
      realtimeItemId: uniqueId("rt"),
    });

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(
        openRouterResponse(threeSectionPayload({ conversation: "orphan ctx" })),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBe("orphan ctx");
    expect(row?.summaryVersion).toBe(1);

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[1]!.content).toContain("Agent system prompt:\n(none)");
  });

  it("H7 — creates task rows and system_notes for each missing task the reasoner detects", async () => {
    const mocks = context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    // createZeroRun requires a compose with a published version that has a
    // model provider key. createTestCompose creates a version with ANTHROPIC_API_KEY.
    const { userId, orgId } = await context.setupUser();
    const { composeId } = await createTestCompose(
      uniqueId("vcc-reasoner-tasks"),
    );
    const sessionId = await seedTestVoiceChatSession({
      userId,
      orgId,
      agentId: composeId,
    });
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "can you look up flight prices to tokyo?",
      realtimeItemId: uniqueId("rt"),
    });
    await appendTestVoiceChatItem({
      sessionId,
      role: "assistant",
      content: "sure, I will look that up for you right away",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse(
          missingTasksPayload({
            conversation: "Focus: flight research",
            missingTasks: ["Look up flight prices to Tokyo"],
          }),
        ),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);
    // Missing-task creation schedules createZeroRun() dispatch via waitUntil().
    // Drain it here so its runner "job" Ably publish cannot leak into H6.
    await mocks.flushAfter();

    // The reasoner summary write should succeed
    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBe("Focus: flight research");
    expect(row?.summaryVersion).toBe(1);
    expect(row?.reasoningStatus).toBe("idle");

    // A task row must have been created for the missing task
    const tasks = await listTestVoiceChatTasks(sessionId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.prompt).toBe("Look up flight prices to Tokyo");
    expect(tasks[0]!.callId).toMatch(/^reasoner-auto-/u);

    // A system_note must have been appended for the auto-created task
    const items = await readTestVoiceChatItems(sessionId);
    const systemNotes = items.filter((i) => {
      return i.role === "system_note";
    });
    expect(systemNotes).toHaveLength(1);
    expect(systemNotes[0]!.content).toBe(
      "Reasoner auto-created task: Look up flight prices to Tokyo",
    );

    // Ably signal published (for both the summary write and the missing-tasks step)
    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat:${sessionId}`,
      null,
    );
  });

  it("H6 — skips the reasoner call when there are no items or tasks", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(
        openRouterResponse(
          threeSectionPayload({ conversation: "should-not-be-called" }),
        ),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await getTestVoiceChatSessionReasoningState(sessionId);
    expect(row?.conversationSummary).toBeNull();
    expect(row?.summaryVersion).toBe(0);
    expect(row?.reasoningStatus).toBe("idle");
    expect(row?.reasoningPending).toBe(false);
    expect(handler.mocked).not.toHaveBeenCalled();
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("H7 — uses only the heard portion of an interrupted assistant turn", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendTestVoiceChatItem({
      sessionId,
      role: "user",
      content: "tell me the update",
      realtimeItemId: uniqueId("rt"),
    });
    await appendTestVoiceChatItem({
      sessionId,
      role: "assistant",
      content: "the full answer that should not survive resume",
      realtimeItemId: "rt-asst-interrupted",
    });
    await appendTestVoiceChatItem({
      sessionId,
      role: "system_note",
      content: JSON.stringify({
        type: "assistant_interrupted",
        assistantRealtimeItemId: "rt-asst-interrupted",
        heardText: "the partial answer the user actually heard",
        audioEndMs: 1200,
      }),
      realtimeItemId: uniqueId("truncate"),
    });

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(
        openRouterResponse(
          threeSectionPayload({ conversation: "Focus: partial answer" }),
        ),
      );
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[1]!.content).toContain(
      "assistant: the partial answer the user actually heard",
    );
    expect(body.messages[1]!.content).not.toContain(
      "the full answer that should not survive resume",
    );
    expect(body.messages[1]!.content).not.toContain("assistant_interrupted");
  });
});

describe("triggerReasoning — task compaction", () => {
  it("C1 — no-ops when OPENROUTER_API_KEY is absent", async () => {
    context.setupMocks();
    // No OPENROUTER_API_KEY set — env() returns it as undefined
    const { sessionId } = await seedActiveSession();
    await insertTestVoiceChatTask(sessionId);

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    // Reasoner skips (no items), compactor also skips (no API key) — one call max
    expect(handler.mocked).not.toHaveBeenCalled();
  });

  it("C2 — skips tasks whose result is at or below 300 chars", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    const taskId = await insertTestVoiceChatTask(sessionId, {
      result: "Short result",
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    // Only the reasoner debounce path runs (no items); compactor skips short result
    const task = await getTestVoiceChatTask(taskId);
    expect(task?.result).toBe("Short result");
  });

  it("C3 — skips tasks updated within 60 seconds", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    const taskId = await insertTestVoiceChatTask(sessionId, {
      resultUpdatedAt: tenSecondsAgo,
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const task = await getTestVoiceChatTask(taskId);
    expect(task?.result).not.toBe("compacted");
  });

  it("C4 — compacts eligible task and publishes Ably signal", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    const taskId = await insertTestVoiceChatTask(sessionId);

    const compactedText = "B".repeat(400) + " key facts retained";
    // triggerReasoning takes the debounce bail-out (no items), then calls
    // compactVoiceChatTaskResults which hits OpenRouter for the task.
    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(compactedText));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const task = await getTestVoiceChatTask(taskId);
    expect(task?.result).toBe(compactedText);
    expect(task?.resultUpdatedAt).not.toBeNull();

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat:${sessionId}`,
      null,
    );
  });

  it("C5 — LLM network error leaves the task unchanged", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    const originalResult = "C".repeat(500) + " original content";
    const taskId = await insertTestVoiceChatTask(sessionId, {
      result: originalResult,
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.error();
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const task = await getTestVoiceChatTask(taskId);
    expect(task?.result).toBe(originalResult);
  });

  it("C6 — running tasks are not compacted", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    const taskId = await insertTestVoiceChatTask(sessionId, {
      result: "D".repeat(600) + " partial result",
      status: "running",
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const task = await getTestVoiceChatTask(taskId);
    expect(task?.result).toContain("partial result");
  });
});
