import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { postRequest, seedCandidateAgent, setupCandidateOrg } from "./_helpers";

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

describe("POST /api/zero/voice-chat-candidate (createSession)", () => {
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
    const response = await POST(postRequest("", { agentId: randomUUID() }));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(postRequest("", { agentId: randomUUID() }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when agentId is not a uuid", async () => {
    const response = await POST(postRequest("", { agentId: "not-a-uuid" }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 when the body is missing", async () => {
    const response = await POST(postRequest(""));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("creates a new session tagged with the caller's org/user and the posted agent", async () => {
    const { agentId } = await seedCandidateAgent(userId, orgId);
    const response = await POST(postRequest("", { agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toBeDefined();
    expect(body.session.orgId).toBe(orgId);
    expect(body.session.userId).toBe(userId);
    expect(body.session.agentId).toBe(agentId);
    expect(body.session.mode).toBe("chat");
    expect(body.session.summarySeq).toBe(0);
    expect(body.session.summaryVersion).toBe(0);
    expect(typeof body.session.createdAt).toBe("string");
  });
});
