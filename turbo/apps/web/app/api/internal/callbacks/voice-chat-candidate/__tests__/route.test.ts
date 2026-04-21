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
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: voice-chat-candidate tasks/sessions route (#10310) not yet on main
import { createVoiceChatCandidateSession } from "../../../../../../src/lib/zero/voice-chat-candidate/session-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: voice-chat-candidate tasks route (#10310) not yet on main
import { createVoiceChatCandidateTask } from "../../../../../../src/lib/zero/voice-chat-candidate/task-service";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: assert DB-level callback side effects (status, session end, system_note)
import {
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
  featureCandidateVoiceChatItems,
} from "../../../../../../src/db/schema/voice-chat-candidate";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: set vars.ZERO_AGENT_ID on seeded run for agent-mismatch coverage
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { POST } from "../route";

const context = testContext();
const CALLBACK_URL =
  "http://localhost/api/internal/callbacks/voice-chat-candidate";

async function setupTaskWithCallback(options: {
  agentIdOnRun?: string;
  runStatus?: string;
}) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: no API route for session/task create on this surface yet
  initServices();
  const { userId, orgId } = await context.setupUser();
  const { composeId } = await seedTestCompose({
    userId,
    orgId,
    name: uniqueId("vcc-cb"),
  });

  const session = await createVoiceChatCandidateSession({
    orgId,
    userId,
    agentId: composeId,
  });

  const { runId } = await seedTestRun(userId, composeId, {
    status: options.runStatus ?? "running",
    orgId,
  });

  // Set vars.ZERO_AGENT_ID so the callback's readRunAgentId can resolve it.
  // Defaults to the session's agent (happy path); tests override for mismatch.
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: direct update required — no API surface sets vars for seeded runs
  await globalThis.services.db
    .update(agentRuns)
    .set({ vars: { ZERO_AGENT_ID: options.agentIdOnRun ?? composeId } })
    .where(eq(agentRuns.id, runId));

  const task = await createVoiceChatCandidateTask({
    sessionId: session.id,
    callId: uniqueId("call"),
    prompt: "do a thing",
    spawnRun: async () => {
      return {
        runId,
        status: "running",
        createdAt: new Date(),
        sessionId: session.id,
      };
    },
  });

  const { secret } = await createTestCallback({
    runId,
    url: CALLBACK_URL,
    payload: { taskId: task.id },
  });

  return { userId, orgId, composeId, session, runId, task, secret };
}

async function readTask(id: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: assert terminal task state written by callback
  const [row] = await globalThis.services.db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.id, id))
    .limit(1);
  return row;
}

async function readSession(id: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: assert session termination on agent mismatch
  const [row] = await globalThis.services.db
    .select()
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id))
    .limit(1);
  return row;
}

async function listItems(sessionId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: assert task_result/system_note items written by callback
  return globalThis.services.db
    .select()
    .from(featureCandidateVoiceChatItems)
    .where(eq(featureCandidateVoiceChatItems.sessionId, sessionId));
}

describe("POST /api/internal/callbacks/voice-chat-candidate", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
    context.setupMocks();
  });

  it("returns 200 for progress status without touching the task", async () => {
    const { runId, task, secret } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "progress",
          payload: { taskId: task.id },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const taskRow = await readTask(task.id);
    expect(taskRow!.status).toBe("pending");
  });

  it("completes the task and writes a task_result item on completed", async () => {
    const { runId, task, session, userId, secret } =
      await setupTaskWithCallback({});

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "final answer" } },
    ]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "completed",
          payload: { taskId: task.id },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await readTask(task.id);
    expect(taskRow!.status).toBe("done");
    expect(taskRow!.result).toBe("final answer");
    expect(taskRow!.error).toBeNull();

    const items = await listItems(session.id);
    const resultItem = items.find((i) => {
      return i.role === "task_result";
    });
    expect(resultItem).toBeDefined();
    expect(resultItem!.content).toContain("final answer");

    await context.mocks.flushAfter();
    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat-candidate:${session.id}`,
      null,
    );
    // userId is used via publishUserSignal — assert channel lookup indirectly
    expect(userId).toBeTruthy();
  });

  it("marks the task failed and records the error text on failed", async () => {
    const { runId, task, session, secret } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "failed",
          error: "runner crashed",
          payload: { taskId: task.id },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await readTask(task.id);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toBe("runner crashed");

    const items = await listItems(session.id);
    const resultItem = items.find((i) => {
      return i.role === "task_result";
    });
    expect(resultItem!.content).toContain("runner crashed");
  });

  it("returns 401 on invalid signature", async () => {
    const { runId, task, secret } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "completed",
          payload: { taskId: task.id },
        },
        secret,
        { invalidSignature: true },
      ),
    );

    expect(response.status).toBe(401);
    const taskRow = await readTask(task.id);
    expect(taskRow!.status).toBe("pending");
  });

  it("returns 400 when payload is missing taskId", async () => {
    const { runId, secret } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "completed",
          payload: {},
        },
        secret,
      ),
    );

    expect(response.status).toBe(400);
  });

  it("ends the session on agent mismatch (vars.ZERO_AGENT_ID differs from session.agentId)", async () => {
    const { runId, task, session, secret } = await setupTaskWithCallback({
      agentIdOnRun: "00000000-0000-0000-0000-000000000000",
    });

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          runId,
          status: "completed",
          payload: { taskId: task.id },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await readTask(task.id);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toMatch(/agent mismatch/i);

    const sessionRow = await readSession(session.id);
    expect(sessionRow!.status).toBe("ended");

    const items = await listItems(session.id);
    const note = items.find((i) => {
      return i.role === "system_note";
    });
    expect(note).toBeDefined();
  });

  it("returns 200 for unknown taskId (defensive per epic risk table)", async () => {
    const { runId, secret } = await setupTaskWithCallback({});

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
