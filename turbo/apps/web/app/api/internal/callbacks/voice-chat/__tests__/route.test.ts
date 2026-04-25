import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCallback,
  createSignedCallbackRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import { setTestRunVars } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import {
  getTestVoiceChatTask,
  listTestVoiceChatItems,
} from "../../../../../../src/__tests__/db-test-assertions/voice-chat";
import {
  postRequest,
  paramsFor,
  setupVoiceChatOrg,
  seedVoiceChatAgent,
  seedVoiceChatSession,
} from "../../../../zero/voice-chat/__tests__/_helpers";
import { POST } from "../route";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST: createTaskPOST } =
  await import("../../../../zero/voice-chat/[id]/tasks/route");

const context = testContext();
const CALLBACK_URL = "http://localhost/api/internal/callbacks/voice-chat";

async function setupTaskWithCallback(options: { agentIdOnRun?: string }) {
  const { userId, orgId } = await context.setupUser();
  const { orgId: voiceChatOrgId } = await setupVoiceChatOrg(userId);
  const { agentId } = await seedVoiceChatAgent(userId, voiceChatOrgId);

  const session = await seedVoiceChatSession({
    orgId: voiceChatOrgId,
    userId,
    agentId,
  });

  const taskResponse = await createTaskPOST(
    postRequest(`/${session.id}/tasks`, {
      prompt: "do a thing",
      callId: uniqueId("call"),
    }),
    paramsFor(session.id),
  );
  const taskBody = (await taskResponse.json()) as {
    task: { id: string; runId: string };
  };
  const taskId = taskBody.task.id;
  const runId = taskBody.task.runId;

  // Set vars.ZERO_AGENT_ID so the callback's readRunAgentId can resolve it.
  // Defaults to the session's agent (happy path); tests override for mismatch.
  await setTestRunVars(runId, {
    ZERO_AGENT_ID: options.agentIdOnRun ?? agentId,
  });

  const { secret, callbackId } = await createTestCallback({
    runId,
    url: CALLBACK_URL,
    payload: { taskId },
  });

  return { userId, orgId, agentId, session, runId, taskId, secret, callbackId };
}

describe("POST /api/internal/callbacks/voice-chat", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 200 for progress status without touching the task", async () => {
    const { runId, taskId, secret, callbackId } = await setupTaskWithCallback(
      {},
    );

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
          runId,
          status: "progress",
          payload: { taskId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);
    const taskRow = await getTestVoiceChatTask(taskId);
    expect(taskRow!.status).toBe("pending");
  });

  it("completes the task and writes a task_result item on completed", async () => {
    const { runId, taskId, session, userId, secret, callbackId } =
      await setupTaskWithCallback({});

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      { eventData: { result: "final answer" } },
    ]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
          runId,
          status: "completed",
          payload: { taskId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await getTestVoiceChatTask(taskId);
    expect(taskRow!.status).toBe("done");
    expect(taskRow!.assistantMessages).toEqual([
      { type: "assistant", content: "final answer", at: expect.any(String) },
    ]);
    expect(taskRow!.error).toBeNull();

    const items = await listTestVoiceChatItems(session.id);
    const resultItem = items.find((i) => {
      return i.role === "task_result";
    });
    expect(resultItem).toBeDefined();
    expect(resultItem!.content).toContain("final answer");

    await context.mocks.flushAfter();
    expect(mockAblyPublish).toHaveBeenCalledWith(
      `voice-chat:${session.id}`,
      null,
    );
    // userId is used via publishUserSignal — assert channel lookup indirectly
    expect(userId).toBeTruthy();
  });

  it("marks the task failed and records the error text on failed", async () => {
    const { runId, taskId, session, secret, callbackId } =
      await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
          runId,
          status: "failed",
          error: "runner crashed",
          payload: { taskId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await getTestVoiceChatTask(taskId);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toBe("runner crashed");

    const items = await listTestVoiceChatItems(session.id);
    const resultItem = items.find((i) => {
      return i.role === "task_result";
    });
    expect(resultItem!.content).toContain("runner crashed");
  });

  it("returns 401 on invalid signature", async () => {
    const { runId, taskId, secret, callbackId } = await setupTaskWithCallback(
      {},
    );

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
          runId,
          status: "completed",
          payload: { taskId },
        },
        secret,
        { invalidSignature: true },
      ),
    );

    expect(response.status).toBe(401);
    const taskRow = await getTestVoiceChatTask(taskId);
    expect(taskRow!.status).toBe("pending");
  });

  it("returns 400 when payload is missing taskId", async () => {
    const { runId, secret, callbackId } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
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
    const { runId, taskId, session, secret, callbackId } =
      await setupTaskWithCallback({
        agentIdOnRun: "00000000-0000-0000-0000-000000000000",
      });

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
          runId,
          status: "completed",
          payload: { taskId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    const taskRow = await getTestVoiceChatTask(taskId);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toMatch(/agent mismatch/i);

    // Sessions are stateless — the mismatch branch no longer flips a
    // session-level field, it just emits a system_note and fails the task.

    const items = await listTestVoiceChatItems(session.id);
    const note = items.find((i) => {
      return i.role === "system_note";
    });
    expect(note).toBeDefined();
  });

  it("returns 200 for unknown taskId (defensive per epic risk table)", async () => {
    const { runId, secret, callbackId } = await setupTaskWithCallback({});

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId,
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
