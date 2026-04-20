import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import { findTestZeroRun } from "../../../../../../../src/__tests__/db-test-assertions/runs";
import {
  endCandidateSession,
  postRequest,
  paramsFor,
  seedCandidateAgent,
  seedCandidateSession,
  setupCandidateOrg,
} from "../../../__tests__/_helpers";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST } = await import("../route");

const context = testContext();

function taskBody(overrides: Partial<{ prompt: string; callId: string }> = {}) {
  return {
    prompt: "Check Grafana for the latest deploy",
    callId: randomUUID(),
    ...overrides,
  };
}

describe("POST /api/zero/voice-chat-candidate/:id/tasks (createTask)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupCandidateOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(
      postRequest(`/${randomUUID()}/tasks`, taskBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${session.id}/tasks`, taskBody()),
      paramsFor(session.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await POST(
      postRequest(`/${randomUUID()}/tasks`, taskBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session belongs to a different user", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupCandidateOrg(other.userId);
    const { agentId } = await seedCandidateAgent(other.userId, otherOrg.orgId);
    const otherSession = await seedCandidateSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId,
    });
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    const response = await POST(
      postRequest(`/${otherSession.id}/tasks`, taskBody()),
      paramsFor(otherSession.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when the session has ended", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    await endCandidateSession(session.id);
    const response = await POST(
      postRequest(`/${session.id}/tasks`, taskBody()),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when prompt is missing", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/tasks`, { callId: randomUUID() }),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when callId is missing", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/tasks`, { prompt: "do a thing" }),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("creates a task and dispatches a zero run with triggerSource=voice-chat", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    const callId = randomUUID();
    const response = await POST(
      postRequest(
        `/${session.id}/tasks`,
        taskBody({ prompt: "summarize latest", callId }),
      ),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.task.sessionId).toBe(session.id);
    expect(body.task.callId).toBe(callId);
    expect(body.task.prompt).toBe("summarize latest");
    expect(["pending", "queued"]).toContain(body.task.status);
    expect(body.task.runId).toBeTruthy();

    const zeroRun = await findTestZeroRun(body.task.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");
  });
});
