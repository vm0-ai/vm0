import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  getRequest,
  paramsFor,
  seedVoiceChatAgent,
  seedVoiceChatSession,
  setupVoiceChatOrg,
} from "../../__tests__/_helpers";

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

const { GET } = await import("../route");

const context = testContext();

describe("GET /api/zero/voice-chat/:id (getSession)", () => {
  let orgId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupVoiceChatOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await GET(
      getRequest(`/${randomUUID()}`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 when the feature flag is disabled (avoids leaking existence)", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await GET(
      getRequest(`/${session.id}`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await GET(
      getRequest(`/${randomUUID()}`),
      paramsFor(randomUUID()),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 when the session belongs to a different user", async () => {
    const other = await context.setupUser({ prefix: "other-user" });
    const otherOrg = await setupVoiceChatOrg(other.userId);
    const { agentId } = await seedVoiceChatAgent(other.userId, otherOrg.orgId);
    const otherSession = await seedVoiceChatSession({
      orgId: otherOrg.orgId,
      userId: other.userId,
      agentId,
    });
    // Switch back to the first user
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    const response = await GET(
      getRequest(`/${otherSession.id}`),
      paramsFor(otherSession.id),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns the session when it belongs to the caller", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await GET(
      getRequest(`/${session.id}`),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.session.id).toBe(session.id);
    expect(body.session.userId).toBe(userId);
    expect(body.session.orgId).toBe(orgId);
    expect(body.session.agentId).toBe(agentId);
  });
});
