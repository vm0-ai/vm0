import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { seedTestCompose } from "../../../../../../src/__tests__/db-test-seeders/agents";
import { seedTestRun } from "../../../../../../src/__tests__/db-test-seeders/runs";
import { createSignedCallbackRequest } from "../../../../../../src/__tests__/api-test-helpers/callbacks";
import { mockAblyPublish } from "../../../../../../src/__tests__/ably-mock";
import {
  getRequest,
  paramsFor,
  postRequest,
  seedCandidateAgent,
  seedCandidateSession,
  setupCandidateOrg,
} from "../../../../zero/voice-chat-candidate/__tests__/_helpers";

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

const { POST: createTaskPOST, GET: listTasksGET } =
  await import("../../../../zero/voice-chat-candidate/[id]/tasks/route");

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

type AssistantMessage = {
  type: "assistant";
  content: string;
  at: string;
};

type VoiceChatCandidateTaskBody = {
  id: string;
  runId: string;
  status: string;
  startedAt: string | null;
  assistantMessages: AssistantMessage[];
};

const context = testContext();

async function seedSessionWithQueuedTask() {
  const { userId } = await context.setupUser();
  const { orgId } = await setupCandidateOrg(userId);
  const { agentId } = await seedCandidateAgent(userId, orgId);
  const session = await seedCandidateSession({
    orgId,
    userId,
    agentId,
  });

  const taskResponse = await createTaskPOST(
    postRequest(`/${session.id}/tasks`, {
      prompt: "p",
      callId: uniqueId("call"),
    }),
    paramsFor(session.id),
  );
  const taskBody = (await taskResponse.json()) as {
    task: VoiceChatCandidateTaskBody;
  };

  await context.mocks.flushAfter();
  mockAblyPublish.mockClear();

  return {
    userId,
    orgId,
    session,
    task: taskBody.task,
    runId: taskBody.task.runId,
  };
}

async function getTaskFromRoute(
  sessionId: string,
  taskId: string,
): Promise<VoiceChatCandidateTaskBody> {
  const response = await listTasksGET(
    getRequest(`/${sessionId}/tasks`),
    paramsFor(sessionId),
  );
  const body = (await response.json()) as {
    tasks: VoiceChatCandidateTaskBody[];
  };
  const task = body.tasks.find((candidate) => {
    return candidate.id === taskId;
  });
  if (!task) {
    throw new Error(`Expected task ${taskId} in voice-chat-candidate response`);
  }
  return task;
}

describe("POST /api/internal/event-consumers/voice-chat-candidate", () => {
  beforeEach(() => {
    mockAblyPublish.mockClear();
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
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
    const { userId, orgId, session, task, runId } =
      await seedSessionWithQueuedTask();

    const response = await POST(
      signed({
        runId,
        events: [buildAssistantEvent(1, "hello")],
        context: { userId, orgId },
      }),
    );
    expect(response.status).toBe(200);

    const taskRow = await getTaskFromRoute(session.id, task.id);
    expect(taskRow.status).toBe("running");
    expect(taskRow.startedAt).not.toBeNull();
    expect(taskRow.assistantMessages).toEqual([
      { type: "assistant", content: "hello", at: expect.any(String) },
    ]);

    expect(mockAblyPublish).toHaveBeenCalled();
  });

  it("keeps running status and appends on subsequent events", async () => {
    const { userId, orgId, session, task, runId } =
      await seedSessionWithQueuedTask();

    await POST(
      signed({
        runId,
        events: [buildAssistantEvent(1, "one")],
        context: { userId, orgId },
      }),
    );
    await POST(
      signed({
        runId,
        events: [buildAssistantEvent(2, "two")],
        context: { userId, orgId },
      }),
    );

    const taskRow = await getTaskFromRoute(session.id, task.id);
    expect(taskRow.status).toBe("running");
    expect(taskRow.assistantMessages).toHaveLength(2);
    expect(
      taskRow.assistantMessages.map((e) => {
        return e.content;
      }),
    ).toEqual(["one", "two"]);
  });

  it("tool_use-only event flips status but appends nothing", async () => {
    const { userId, orgId, session, task, runId } =
      await seedSessionWithQueuedTask();

    const response = await POST(
      signed({
        runId,
        events: [buildToolUseEvent(1)],
        context: { userId, orgId },
      }),
    );
    expect(response.status).toBe(200);

    const taskRow = await getTaskFromRoute(session.id, task.id);
    expect(taskRow.status).toBe("running");
    expect(taskRow.assistantMessages).toEqual([]);
  });
});
