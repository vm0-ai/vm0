import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
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

describe("POST /api/zero/voice-chat-candidate/:id/end", () => {
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
      postRequest(`/${randomUUID()}/end`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${session.id}/end`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await POST(
      postRequest(`/${randomUUID()}/end`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
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
      postRequest(`/${otherSession.id}/end`),
      paramsFor(otherSession.id),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("ends the session and returns ok", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/end`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
  });
});
