import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import {
  getRequest,
  paramsFor,
  postRequest,
  seedCandidateAgent,
  seedCandidateSession,
  setupCandidateOrg,
} from "../../../../__tests__/_helpers";

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

async function appendTaskResultItem(
  sessionId: string,
  content: string,
): Promise<void> {
  const { POST } = await import("../../../items/route");
  await POST(
    postRequest(`/${sessionId}/items`, {
      role: "task_result",
      content,
      realtimeItemId: randomUUID(),
    }),
    paramsFor(sessionId),
  );
}

describe("GET /api/zero/voice-chat-candidate/:id/transcript/task-results", () => {
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
    const response = await GET(
      getRequest(`/${randomUUID()}/transcript/task-results`),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await GET(
      getRequest(`/${session.id}/transcript/task-results`),
      paramsFor(session.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await GET(
      getRequest(`/${randomUUID()}/transcript/task-results`),
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
    const response = await GET(
      getRequest(`/${otherSession.id}/transcript/task-results`),
      paramsFor(otherSession.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when sinceSeq is not a valid number", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    const response = await GET(
      getRequest(`/${session.id}/transcript/task-results?sinceSeq=notanumber`),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("returns the latest task_result item when sinceSeq is absent (baseline mode)", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    await appendTaskResultItem(session.id, "result-one");
    await appendTaskResultItem(session.id, "result-two");

    const response = await GET(
      getRequest(`/${session.id}/transcript/task-results`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    // Baseline mode: only the latest single item is returned
    expect(body.items).toHaveLength(1);
    expect(body.items[0].content).toBe("result-two");
    expect(body.items[0].role).toBe("task_result");
    expect(body.items[0].sessionId).toBe(session.id);
  });

  it("returns items after sinceSeq in ascending order (increment mode)", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    await appendTaskResultItem(session.id, "result-one");
    await appendTaskResultItem(session.id, "result-two");

    // Baseline call to get the cursor
    const baselineResponse = await GET(
      getRequest(`/${session.id}/transcript/task-results`),
      paramsFor(session.id),
    );
    const baselineBody = await baselineResponse.json();
    const cursorSeq = baselineBody.items[0].seq as number;

    // Append one more item after the cursor
    await appendTaskResultItem(session.id, "result-three");

    const response = await GET(
      getRequest(
        `/${session.id}/transcript/task-results?sinceSeq=${cursorSeq}`,
      ),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].content).toBe("result-three");
  });

  it("returns empty array when no items exist and sinceSeq is 0", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });

    const response = await GET(
      getRequest(`/${session.id}/transcript/task-results?sinceSeq=0`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(0);
  });
});
