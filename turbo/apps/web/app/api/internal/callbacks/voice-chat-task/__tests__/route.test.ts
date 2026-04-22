import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCallback,
  createSignedCallbackRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import { seedTestCompose } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import { initServices } from "../../../../../../src/lib/init-services";
/* eslint-disable web/no-direct-db-in-tests -- Service-level exception: assert callback DB side effects on tasks/events */
import {
  voiceChatSessions,
  voiceChatTasks,
  voiceChatEvents,
} from "../../../../../../src/db/schema/voice-chat";
/* eslint-enable web/no-direct-db-in-tests */
/* eslint-disable web/no-direct-db-in-tests -- Service-level exception: no API surface creates a task row with a pre-assigned runId for callback setup */
import {
  attachTaskRun,
  createVoiceChatTask,
} from "../../../../../../src/lib/zero/voice-chat/task-service";
/* eslint-enable web/no-direct-db-in-tests */

const { POST } = await import("../route");

const context = testContext();
const CALLBACK_URL = "http://localhost/api/internal/callbacks/voice-chat-task";

async function setupTaskWithCallback(options?: {
  runStatus?: string;
}): Promise<{
  userId: string;
  orgId: string;
  sessionId: string;
  taskId: string;
  runId: string;
  secret: string;
}> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: helper seeds a task row with a pre-assigned runId for callback setup
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vc-task-cb"),
  });

  /* eslint-disable web/no-direct-db-in-tests -- Service-level exception: no API route creates voice-chat sessions in active state */
  const [session] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId,
      userId,
      agentId: composeId,
      status: "active",
    })
    .returning();
  /* eslint-enable web/no-direct-db-in-tests */

  const task = await createVoiceChatTask({
    sessionId: session!.id,
    prompt: "do a thing",
  });

  const { runId } = await seedTestRun(userId, composeId, {
    status: options?.runStatus ?? "running",
    orgId,
    triggerSource: "voice-chat",
  });

  await attachTaskRun({ taskId: task.id, runId });

  const { secret } = await createTestCallback({
    runId,
    url: CALLBACK_URL,
    payload: { taskId: task.id },
  });

  return {
    userId,
    orgId,
    sessionId: session!.id,
    taskId: task.id,
    runId,
    secret,
  };
}

async function readTask(id: string) {
  /* eslint-disable web/no-direct-db-in-tests -- Service-level exception: assert terminal task state written by callback */
  const [row] = await globalThis.services.db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.id, id))
    .limit(1);
  /* eslint-enable web/no-direct-db-in-tests */
  return row;
}

async function listEvents(sessionId: string) {
  /* eslint-disable web/no-direct-db-in-tests -- Service-level exception: assert task-completed event written after session-end */
  return globalThis.services.db
    .select()
    .from(voiceChatEvents)
    .where(eq(voiceChatEvents.sessionId, sessionId));
  /* eslint-enable web/no-direct-db-in-tests */
}

describe("POST /api/internal/callbacks/voice-chat-task", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
    context.setupMocks();
  });

  it("returns 200 for progress status without touching the task", async () => {
    const { runId, taskId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "progress", payload: { taskId } },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const row = await readTask(taskId);
    expect(row!.status).toBe("queued");
    expect(row!.finishedAt).toBeNull();
  });

  it("marks the task done with the extracted output text on completed", async () => {
    const { runId, taskId, sessionId, secret } = await setupTaskWithCallback();

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "final answer" } },
    ]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "completed", payload: { taskId } },
        secret,
      ),
    );
    expect(response.status).toBe(200);

    const row = await readTask(taskId);
    expect(row!.status).toBe("done");
    expect(row!.result).toBe("final answer");
    expect(row!.error).toBeNull();
    expect(row!.finishedAt).not.toBeNull();

    const events = await listEvents(sessionId);
    const completed = events.find((e) => {
      return e.type === "task-completed";
    });
    expect(completed).toBeTruthy();
    expect(completed!.source).toBe("system");
    expect(completed!.content).toBe(JSON.stringify({ taskId }));

    await context.mocks.flushAfter();
    expect(mockAblyPublish).toHaveBeenCalledWith(`voice:${sessionId}`, null);
  });

  it("marks the task failed with the error text on failed", async () => {
    const { runId, taskId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "failed",
          error: "runner crashed",
          payload: { taskId },
        },
        secret,
      ),
    );
    expect(response.status).toBe(200);

    const row = await readTask(taskId);
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("runner crashed");
    expect(row!.result).toBeNull();
  });

  it("maps cancelled to failed with 'Run cancelled' default error", async () => {
    const { runId, taskId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "cancelled", payload: { taskId } },
        secret,
      ),
    );
    expect(response.status).toBe(200);

    const row = await readTask(taskId);
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("Run cancelled");
  });

  it("maps timeout to failed with 'Run timeout' default error", async () => {
    const { runId, taskId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "timeout", payload: { taskId } },
        secret,
      ),
    );
    expect(response.status).toBe(200);

    const row = await readTask(taskId);
    expect(row!.status).toBe("failed");
    expect(row!.error).toBe("Run timeout");
  });

  it("writes the task-completed event even when the session has already ended", async () => {
    const { runId, taskId, sessionId, secret } = await setupTaskWithCallback();

    /* eslint-disable web/no-direct-db-in-tests -- Service-level exception: simulate race where session ends before callback fires */
    await globalThis.services.db
      .update(voiceChatSessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(voiceChatSessions.id, sessionId));
    /* eslint-enable web/no-direct-db-in-tests */

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "late result" } },
    ]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "completed", payload: { taskId } },
        secret,
      ),
    );
    expect(response.status).toBe(200);

    const events = await listEvents(sessionId);
    expect(
      events.find((e) => {
        return e.type === "task-completed";
      }),
    ).toBeTruthy();
  });

  it("returns 401 on invalid signature without touching the task", async () => {
    const { runId, taskId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "completed", payload: { taskId } },
        secret,
        { invalidSignature: true },
      ),
    );
    expect(response.status).toBe(401);

    const row = await readTask(taskId);
    expect(row!.status).toBe("queued");
  });

  it("returns 400 when payload is missing taskId", async () => {
    const { runId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        { runId, status: "completed", payload: {} },
        secret,
      ),
    );
    expect(response.status).toBe(400);
  });

  it("returns 200 for unknown taskId (silent no-op)", async () => {
    const { runId, secret } = await setupTaskWithCallback();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "completed",
          payload: { taskId: "00000000-0000-0000-0000-000000000000" },
        },
        secret,
      ),
    );
    expect(response.status).toBe(200);
  });
});
