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
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers these services yet
import {
  appendVoiceChatCandidateItem,
  readVoiceChatCandidateItems,
} from "../item-service";
import { triggerReasoning } from "../trigger-reasoning";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
import { featureCandidateVoiceChatSessions } from "../../../../db/schema/voice-chat-candidate";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const context = testContext();

function openRouterResponse(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

async function seedActiveSession(): Promise<{
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
    name: uniqueId("vcc-reasoner"),
  });
  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });
  return { userId, orgId, sessionId: session.id };
}

async function readSession(id: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: verify DB side-effects directly
  const db = globalThis.services.db;
  const [row] = await db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id))
    .limit(1);
  return row!;
}

describe("triggerReasoning", () => {
  it("H1 — writes context, bumps seq/version, and publishes on success", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendVoiceChatCandidateItem({
      sessionId,
      role: "user",
      content: "hello",
      realtimeItemId: uniqueId("rt"),
    });
    const b = await appendVoiceChatCandidateItem({
      sessionId,
      role: "assistant",
      content: "hi there",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("updated context"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await readSession(sessionId);
    expect(row.context).toBe("updated context");
    expect(row.contextSeq).toBe(b!.seq);
    expect(row.contextVersion).toBe(1);
    expect(row.reasoningStatus).toBe("idle");
    expect(row.reasoningPending).toBe(false);
    expect(row.lastReasoningAt).not.toBeNull();
    expect(handler.mocked).toHaveBeenCalledTimes(1);

    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat-candidate:${sessionId}`,
      null,
    );
  });

  it("H2 — appends system_note and does not publish when the reasoner returns null", async () => {
    context.setupMocks();
    // OPENROUTER_API_KEY is intentionally absent — callReasoner short-circuits
    // to null, which is exactly the "reasoner failed" branch we want to cover.
    const { sessionId } = await seedActiveSession();
    await appendVoiceChatCandidateItem({
      sessionId,
      role: "user",
      content: "anything",
      realtimeItemId: uniqueId("rt"),
    });

    await triggerReasoning(sessionId);

    const row = await readSession(sessionId);
    expect(row.context).toBeNull();
    expect(row.contextVersion).toBe(0);
    expect(row.reasoningStatus).toBe("idle");
    // lastReasoningAt is bumped on both success and failure branches so
    // operators can distinguish "ticks running but failing" from "no tick ran".
    expect(row.lastReasoningAt).not.toBeNull();

    const items = await readVoiceChatCandidateItems(sessionId);
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
    await appendVoiceChatCandidateItem({
      sessionId,
      role: "user",
      content: "concurrent",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("ctx"));
    });
    server.use(handler.handler);

    await Promise.all([
      triggerReasoning(sessionId),
      triggerReasoning(sessionId),
    ]);

    // The second trigger set reasoning_pending; the first must have drained it
    // and scheduled an after() re-tick. Flush the queue so the drain fires.
    await mocks.flushAfter();

    const row = await readSession(sessionId);
    expect(row.reasoningStatus).toBe("idle");
    expect(row.reasoningPending).toBe(false);
    expect(row.contextVersion).toBe(1);
    // Exactly one OpenRouter call — the drain re-tick sees no new items and
    // takes the debounce bailout (Decision H6).
    expect(handler.mocked).toHaveBeenCalledTimes(1);
    expect(mockAblyPublish).toHaveBeenCalledTimes(1);
  });

  it("H4 — a concurrent contextVersion bump causes the write to drop silently", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();
    await appendVoiceChatCandidateItem({
      sessionId,
      role: "user",
      content: "racy",
      realtimeItemId: uniqueId("rt"),
    });

    const handler = http.post(OPENROUTER_URL, async () => {
      // Simulate another tick winning the write race between our snapshot
      // and our optimistic UPDATE.
      // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: simulate concurrent write
      const db = globalThis.services.db;
      await db
        .update(featureCandidateVoiceChatSessions)
        .set({ contextVersion: 99, context: "written by another tick" })
        .where(eq(featureCandidateVoiceChatSessions.id, sessionId));
      return HttpResponse.json(openRouterResponse("stale context"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await readSession(sessionId);
    expect(row.context).toBe("written by another tick");
    expect(row.contextVersion).toBe(99);
    expect(row.reasoningStatus).toBe("idle");
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("H5 — runs successfully when the session has no associated agent", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: createVoiceChatCandidateSession requires agentId; tests for the null-agent path insert directly
    initServices();
    const { userId, orgId } = await context.setupUser();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed a session without an agent
    const db = globalThis.services.db;
    const [session] = await db
      .insert(featureCandidateVoiceChatSessions)
      .values({ orgId, userId, agentId: null })
      .returning();
    const sessionId = session!.id;
    await appendVoiceChatCandidateItem({
      sessionId,
      role: "user",
      content: "sans-agent",
      realtimeItemId: uniqueId("rt"),
    });

    let capturedBody: unknown;
    const handler = http.post(OPENROUTER_URL, async ({ request }) => {
      capturedBody = await request.json();
      return HttpResponse.json(openRouterResponse("orphan ctx"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await readSession(sessionId);
    expect(row.context).toBe("orphan ctx");
    expect(row.contextVersion).toBe(1);

    const body = capturedBody as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[1]!.content).toContain("Agent system prompt:\n(none)");
  });

  it("H6 — skips the reasoner call when there are no new items or pending tasks", async () => {
    context.setupMocks();
    vi.stubEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    reloadEnv();

    const { sessionId } = await seedActiveSession();

    const handler = http.post(OPENROUTER_URL, () => {
      return HttpResponse.json(openRouterResponse("should-not-be-called"));
    });
    server.use(handler.handler);

    await triggerReasoning(sessionId);

    const row = await readSession(sessionId);
    expect(row.context).toBeNull();
    expect(row.contextVersion).toBe(0);
    expect(row.reasoningStatus).toBe("idle");
    expect(row.reasoningPending).toBe(false);
    expect(handler.mocked).not.toHaveBeenCalled();
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });
});
