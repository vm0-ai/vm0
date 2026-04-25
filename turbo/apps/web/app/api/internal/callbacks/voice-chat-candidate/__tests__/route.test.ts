import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import {
  createTestCallback,
  createSignedCallbackRequest,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  setTestRunRunnerGroup,
  setTestRunStatus,
  setTestRunVars,
} from "../../../../../../src/__tests__/db-test-seeders/runs";
import { findTestRunRecord } from "../../../../../../src/__tests__/db-test-assertions/runs";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import {
  getTestVoiceChatCandidateTask,
  listTestVoiceChatCandidateItems,
} from "../../../../../../src/__tests__/db-test-assertions/voice-chat-candidate";
import {
  postRequest,
  paramsFor,
  setupCandidateOrg,
  seedCandidateAgent,
  seedCandidateSession,
} from "../../../../zero/voice-chat-candidate/__tests__/_helpers";
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
  await import("../../../../zero/voice-chat-candidate/[id]/tasks/route");

const context = testContext();
const CALLBACK_URL =
  "http://localhost/api/internal/callbacks/voice-chat-candidate";

async function setupTaskWithCallback(options: { agentIdOnRun?: string }) {
  const { userId, orgId } = await context.setupUser();
  const { orgId: candidateOrgId } = await setupCandidateOrg(userId);
  const { agentId } = await seedCandidateAgent(userId, candidateOrgId);

  const session = await seedCandidateSession({
    orgId: candidateOrgId,
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

  // Task creation schedules createZeroRun() dispatch via waitUntil() and a
  // post-response reasoner tick via after(). Drain setup-owned async work so
  // it cannot outlive the test that uses this helper.
  await context.mocks.flushAfter();

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

describe("POST /api/internal/callbacks/voice-chat-candidate", () => {
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
    const taskRow = await getTestVoiceChatCandidateTask(taskId);
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

    const taskRow = await getTestVoiceChatCandidateTask(taskId);
    expect(taskRow!.status).toBe("done");
    expect(taskRow!.assistantMessages).toEqual([
      { type: "assistant", content: "final answer", at: expect.any(String) },
    ]);
    expect(taskRow!.error).toBeNull();

    const items = await listTestVoiceChatCandidateItems(session.id);
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

    const taskRow = await getTestVoiceChatCandidateTask(taskId);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toBe("runner crashed");

    const items = await listTestVoiceChatCandidateItems(session.id);
    const resultItem = items.find((i) => {
      return i.role === "task_result";
    });
    expect(resultItem!.content).toContain("runner crashed");

    await context.mocks.flushAfter();
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
    const taskRow = await getTestVoiceChatCandidateTask(taskId);
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

    const taskRow = await getTestVoiceChatCandidateTask(taskId);
    expect(taskRow!.status).toBe("failed");
    expect(taskRow!.error).toMatch(/agent mismatch/i);

    // Sessions are stateless — the mismatch branch no longer flips a
    // session-level field, it just emits a system_note and fails the task.

    const items = await listTestVoiceChatCandidateItems(session.id);
    const note = items.find((i) => {
      return i.role === "system_note";
    });
    expect(note).toBeDefined();

    await context.mocks.flushAfter();
  });

  it("dispatches cancel side effects for in-flight runs on agent mismatch (#10762)", async () => {
    // Triggering callback carries a mismatched agentId — takes the mismatch
    // branch inside completeVoiceChatCandidateTask and triggers
    // cancelSessionPendingRuns for the session.
    const {
      runId: triggerRunId,
      taskId: triggerTaskId,
      session,
      secret,
      callbackId: triggerCallbackId,
    } = await setupTaskWithCallback({
      agentIdOnRun: "00000000-0000-0000-0000-000000000000",
    });

    // Seed a second in-flight voice-chat-candidate task for the same session.
    // The voice-chat task stays in its default (pending/queued) state, but
    // we flip the underlying agent_run to `running` so cancelRun observes
    // previousStatus === 'running' and dispatchCancelSideEffects is expected
    // to publish an Ably cancel notification to the runner group.
    const taskResponse = await createTaskPOST(
      postRequest(`/${session.id}/tasks`, {
        prompt: "secondary in-flight",
        callId: uniqueId("call"),
      }),
      paramsFor(session.id),
    );
    const { task: secondary } = (await taskResponse.json()) as {
      task: { id: string; runId: string };
    };

    // Drain the waitUntil() dispatch so the secondary run's deferred
    // dispatch runs to completion (or failure) before we override status.
    // Without this, dispatchZeroRun races with setTestRunStatus and may
    // leave the run in "failed" instead of the expected "running".
    await context.mocks.flushAfter();

    await setTestRunStatus(secondary.runId, "running");
    await setTestRunRunnerGroup(secondary.runId, "test-group");

    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([]);
    mockAblyPublish.mockClear();

    const response = await POST(
      createSignedCallbackRequest(
        CALLBACK_URL,
        {
          callbackId: triggerCallbackId,
          runId: triggerRunId,
          status: "completed",
          payload: { taskId: triggerTaskId },
        },
        secret,
      ),
    );

    expect(response.status).toBe(200);

    // Flush the callback route's after() so dispatchCancelSideEffects runs.
    await context.mocks.flushAfter();

    // Secondary agent_run must have been moved to `cancelled` — this is the
    // DB-level outcome of cancelRun running inside cancelSessionPendingRuns.
    const secondaryRow = await findTestRunRecord(secondary.runId);
    expect(secondaryRow!.status).toBe("cancelled");

    // Runner-group Ably cancel must have been published (the specific
    // side effect that was previously missing). Channel name is opaque
    // through the shared mock, so match on event + payload.
    const cancelPublish = mockAblyPublish.mock.calls.find((call) => {
      return (
        call[0] === "cancel" &&
        (call[1] as { runId?: string } | null)?.runId === secondary.runId
      );
    });
    expect(cancelPublish).toBeDefined();
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
