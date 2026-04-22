import { describe, it, expect, vi } from "vitest";
import { HttpResponse } from "msw";
import { eq } from "drizzle-orm";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import { seedTestCompose } from "../../../../__tests__/db-test-seeders/agents";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import { mockAblyPublish } from "../../../../__tests__/ably-mock";
import { reloadEnv } from "../../../../env";
import { initServices } from "../../../init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import { createVoiceChatCandidateSession } from "../session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import {
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../../../db/schema/voice-chat-candidate";
import { compactVoiceChatCandidateTaskResults } from "../compact-task-results";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const context = testContext();

function openRouterResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

async function seedSession(): Promise<{
  userId: string;
  orgId: string;
  sessionId: string;
}> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: test exercises services directly, no API route
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-compact"),
  });
  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });
  return { userId, orgId, sessionId: session.id };
}

/**
 * Insert a "done" task row directly. The result is long enough to pass
 * MIN_RESULT_LEN (300) and old enough to pass COMPACT_INTERVAL_MS (60 s).
 */
async function insertDoneTask(
  sessionId: string,
  opts: {
    result?: string;
    resultUpdatedAt?: Date;
  } = {},
): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed task for compact tests
  const db = globalThis.services.db;
  const longResult =
    opts.result ??
    "A".repeat(500) + " important data about the subject matter discussed";
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  const [row] = await db
    .insert(featureCandidateVoiceChatTasks)
    .values({
      sessionId,
      callId: uniqueId("call"),
      prompt: "Summarize the situation",
      status: "done",
      result: longResult,
      resultUpdatedAt: opts.resultUpdatedAt ?? twoMinutesAgo,
      finishedAt: twoMinutesAgo,
    })
    .returning();
  return row!.id;
}

async function readTask(id: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
  const db = globalThis.services.db;
  const [row] = await db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.id, id))
    .limit(1);
  return row!;
}

describe("compactVoiceChatCandidateTaskResults", () => {
  it("C1 — no-ops when OPENROUTER_API_KEY is absent", async () => {
    context.setupMocks();
    // No OPENROUTER_API_KEY set — env() returns it as undefined
    const { sessionId, userId } = await seedSession();
    await insertDoneTask(sessionId);

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    expect(handler.mocked).not.toHaveBeenCalled();
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("C2 — skips tasks whose result is at or below MIN_RESULT_LEN (300 chars)", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed short task
    const db = globalThis.services.db;
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    const [row] = await db
      .insert(featureCandidateVoiceChatTasks)
      .values({
        sessionId,
        callId: uniqueId("call"),
        prompt: "short task",
        status: "done",
        result: "Short result",
        resultUpdatedAt: twoMinutesAgo,
        finishedAt: twoMinutesAgo,
      })
      .returning();
    const taskId = row!.id;

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    expect(handler.mocked).not.toHaveBeenCalled();
    const task = await readTask(taskId);
    expect(task.result).toBe("Short result");
  });

  it("C3 — skips tasks updated within COMPACT_INTERVAL_MS (60 s)", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    // resultUpdatedAt is only 10 seconds ago — too recent
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    const taskId = await insertDoneTask(sessionId, {
      resultUpdatedAt: tenSecondsAgo,
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    expect(handler.mocked).not.toHaveBeenCalled();
    const task = await readTask(taskId);
    expect(task.result).not.toBe("compacted");
  });

  it("C4 — compacts eligible task, writes DB row, and publishes Ably signal", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    const taskId = await insertDoneTask(sessionId);

    const compactedText = "B".repeat(400) + " key facts retained";
    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse(compactedText));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    expect(handler.mocked).toHaveBeenCalledTimes(1);

    const task = await readTask(taskId);
    expect(task.result).toBe(compactedText);
    expect(task.resultUpdatedAt).not.toBeNull();

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat-candidate:${sessionId}`,
      null,
    );
  });

  it("C5 — LLM timeout returns null and the task is left unchanged", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    const originalResult =
      "C".repeat(500) + " original content that should remain";
    const taskId = await insertDoneTask(sessionId, { result: originalResult });

    const handler = http.post(OPENROUTER_URL, () => {
      // Simulate a network error (treated as null by callCompactor)
      return HttpResponse.error();
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    const task = await readTask(taskId);
    expect(task.result).toBe(originalResult);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("C6 — pending/queued/running tasks are not compacted", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed in-flight task
    const db = globalThis.services.db;
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    const [row] = await db
      .insert(featureCandidateVoiceChatTasks)
      .values({
        sessionId,
        callId: uniqueId("call"),
        prompt: "ongoing",
        status: "running",
        result: "D".repeat(600) + " partial result",
        resultUpdatedAt: twoMinutesAgo,
        finishedAt: null,
      })
      .returning();
    const taskId = row!.id;

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("compacted"));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    expect(handler.mocked).not.toHaveBeenCalled();
    const task = await readTask(taskId);
    expect(task.result).toContain("partial result");
  });

  it("C7 — sessions table is not modified by compaction", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    reloadEnv();

    const { sessionId, userId } = await seedSession();
    await insertDoneTask(sessionId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify session row untouched
    const db = globalThis.services.db;
    const [before] = await db
      .select()
      .from(featureCandidateVoiceChatSessions)
      .where(eq(featureCandidateVoiceChatSessions.id, sessionId))
      .limit(1);

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("E".repeat(400)));
    });
    server.use(handler.handler);

    await compactVoiceChatCandidateTaskResults(sessionId, userId);

    const [after] = await db
      .select()
      .from(featureCandidateVoiceChatSessions)
      .where(eq(featureCandidateVoiceChatSessions.id, sessionId))
      .limit(1);

    expect(after!.summaryVersion).toBe(before!.summaryVersion);
    expect(after!.conversationSummary).toBe(before!.conversationSummary);
  });
});
