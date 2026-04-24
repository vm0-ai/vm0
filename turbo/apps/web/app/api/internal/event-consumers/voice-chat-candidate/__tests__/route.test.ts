import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { seedTestCompose } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { createSignedCallbackRequest } from "../../../../../../src/__tests__/api-test-helpers/callbacks";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { initServices } from "../../../../../../src/lib/init-services";
// eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
import { createVoiceChatCandidateSession } from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
import { createVoiceChatCandidateTask } from "../../../../../../src/lib/zero/voice-chat-candidate/task-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
import { voiceChatTasks } from "../../../../../../src/db/schema/voice-chat";

const SECRETS_ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const CONSUMER_URL =
  "http://localhost:3000/api/internal/event-consumers/voice-chat-candidate";

function buildAssistantEvent(
  sequenceNumber: number,
  text: string,
): Record<string, unknown> {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      id: `msg_${sequenceNumber}`,
      content: [{ type: "text", text }],
    },
  };
}

function buildToolUseEvent(sequenceNumber: number): Record<string, unknown> {
  return {
    type: "assistant",
    sequenceNumber,
    message: {
      id: `msg_${sequenceNumber}`,
      content: [{ type: "tool_use", id: "tool_1", name: "bash", input: {} }],
    },
  };
}

async function seedSessionWithQueuedTask() {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route covers this path
  initServices();
  const ctx = testContext();
  const { userId, orgId } = await ctx.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-consumer"),
  });
  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });
  const { runId } = await seedTestRun(userId, composeId, {
    status: "queued",
    orgId,
  });
  const task = await createVoiceChatCandidateTask({
    sessionId: session.id,
    callId: "call-1",
    prompt: "p",
    spawnRun: async () => {
      return {
        runId,
        status: "queued",
        createdAt: new Date(),
        sessionId: session.id,
        markResponseReady: () => {
          return undefined;
        },
      };
    },
  });
  return { userId, orgId, session, task, runId };
}

const context = testContext();

describe("POST /api/internal/event-consumers/voice-chat-candidate", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
    context.setupMocks();
  });

  function signed(body: unknown) {
    return createSignedCallbackRequest(
      CONSUMER_URL,
      body,
      SECRETS_ENCRYPTION_KEY,
    );
  }

  it("rejects invalid signatures", async () => {
    const request = createSignedCallbackRequest(
      CONSUMER_URL,
      { runId: "r", events: [], context: {} },
      "wrong-key",
    );
    const response = await POST(request);
    expect(response.status).toBe(401);
  });

  it("no-ops for runs unrelated to any VCC task", async () => {
    const { userId, orgId } = await context.setupUser();
    const { composeId } = await seedTestCompose({
      userId,
      orgId,
      name: uniqueId("vcc-orphan"),
    });
    const { runId } = await seedTestRun(userId, composeId, {
      status: "queued",
      orgId,
    });

    const response = await POST(
      signed({
        runId,
        events: [buildAssistantEvent(1, "hi")],
        context: { userId, orgId },
      }),
    );
    expect(response.status).toBe(200);
    expect(mockAblyPublish).not.toHaveBeenCalled();
  });

  it("flips queued→running on first event and appends assistant text", async () => {
    const { userId, session, task, runId } = await seedSessionWithQueuedTask();

    const response = await POST(
      signed({
        runId,
        events: [buildAssistantEvent(1, "hello")],
        context: { userId, orgId: session.orgId },
      }),
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
    const db = globalThis.services.db;
    const [row] = await db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, task.id));
    expect(row!.status).toBe("running");
    expect(row!.startedAt).not.toBeNull();
    expect(row!.assistantMessages).toEqual([
      { type: "assistant", content: "hello", at: expect.any(String) },
    ]);

    expect(mockAblyPublish).toHaveBeenCalled();
  });

  it("keeps running status and appends on subsequent events", async () => {
    const { userId, session, task, runId } = await seedSessionWithQueuedTask();

    await POST(
      signed({
        runId,
        events: [buildAssistantEvent(1, "one")],
        context: { userId, orgId: session.orgId },
      }),
    );
    await POST(
      signed({
        runId,
        events: [buildAssistantEvent(2, "two")],
        context: { userId, orgId: session.orgId },
      }),
    );

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
    const db = globalThis.services.db;
    const [row] = await db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, task.id));
    expect(row!.status).toBe("running");
    expect(row!.assistantMessages).toHaveLength(2);
    expect(
      row!.assistantMessages.map((e) => {
        return e.content;
      }),
    ).toEqual(["one", "two"]);
  });

  it("tool_use-only event flips status but appends nothing", async () => {
    const { userId, session, task, runId } = await seedSessionWithQueuedTask();

    const response = await POST(
      signed({
        runId,
        events: [buildToolUseEvent(1)],
        context: { userId, orgId: session.orgId },
      }),
    );
    expect(response.status).toBe(200);

    // eslint-disable-next-line web/no-direct-db-in-tests -- verify DB side-effects directly
    const db = globalThis.services.db;
    const [row] = await db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, task.id));
    expect(row!.status).toBe("running");
    expect(row!.assistantMessages).toEqual([]);
  });
});
