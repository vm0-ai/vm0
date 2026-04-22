import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  insertTestVoiceChatSession,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
// eslint-disable-next-line web/no-direct-db-in-tests -- Service-level exception: seed a task row without dispatching a zero run (no API for that)
import { createVoiceChatTask } from "../../../../../../../../src/lib/zero/voice-chat/task-service";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { GET } = await import("../route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

function taskUrl(sessionId: string, taskId: string): string {
  return `${BASE_URL}/${sessionId}/tasks/${taskId}`;
}

function getTask(sessionId: string, taskId: string) {
  return GET(createTestRequest(taskUrl(sessionId, taskId)), {
    params: Promise.resolve({ id: sessionId, taskId }),
  });
}

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc-task");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { orgId, slug };
}

describe("GET /api/zero/voice-chat/[id]/tasks/[taskId]", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await getTask(randomUUID(), randomUUID());
    expect(response.status).toBe(401);
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await getTask(randomUUID(), randomUUID());
    expect(response.status).toBe(403);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await getTask(randomUUID(), randomUUID());
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session belongs to a different org", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupOrg(other.userId);
    const agent = await createTestCompose(uniqueId("zvc-task-agent"));
    const otherSessionId = await insertTestVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId: agent.composeId,
    });
    const task = await createVoiceChatTask({
      sessionId: otherSessionId,
      prompt: "other",
    });

    mockClerk({ userId, orgId, orgRole: "org:admin" });

    const response = await getTask(otherSessionId, task.id);
    expect(response.status).toBe(404);
  });

  it("returns 404 when the task belongs to a different session", async () => {
    const agent = await createTestCompose(uniqueId("zvc-task-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const otherSessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const taskOnOther = await createVoiceChatTask({
      sessionId: otherSessionId,
      prompt: "other",
    });

    const response = await getTask(sessionId, taskOnOther.id);
    expect(response.status).toBe(404);
  });

  it("returns the serialized task when it belongs to the session", async () => {
    const agent = await createTestCompose(uniqueId("zvc-task-agent"));
    const sessionId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId: agent.composeId,
    });
    const task = await createVoiceChatTask({
      sessionId,
      prompt: "look up",
    });

    const response = await getTask(sessionId, task.id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.task.id).toBe(task.id);
    expect(body.task.sessionId).toBe(sessionId);
    expect(body.task.prompt).toBe("look up");
    expect(body.task.status).toBe("pending");
    expect(body.task.runId).toBeNull();
    expect(body.task.assistantMessages).toEqual([]);
    expect(typeof body.task.createdAt).toBe("string");
    expect(body.task.startedAt).toBeNull();
    expect(body.task.finishedAt).toBeNull();
  });
});
