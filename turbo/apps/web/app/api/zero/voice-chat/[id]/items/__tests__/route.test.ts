import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";
import {
  postRequest,
  paramsFor,
  seedVoiceChatAgent,
  seedVoiceChatSession,
  setupVoiceChatOrg,
} from "../../../__tests__/_helpers";

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

const { POST } = await import("../route");

const context = testContext();

function itemBody(
  overrides: Partial<{
    role: string;
    content: string;
    realtimeItemId: string;
  }> = {},
) {
  return {
    role: "user",
    content: "hello",
    realtimeItemId: randomUUID(),
    ...overrides,
  };
}

describe("POST /api/zero/voice-chat/:id/items (appendItem)", () => {
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
    const response = await POST(
      postRequest(`/${randomUUID()}/items`, itemBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 when the feature flag is disabled", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(
      postRequest(`/${session.id}/items`, itemBody()),
      paramsFor(session.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await POST(
      postRequest(`/${randomUUID()}/items`, itemBody()),
      paramsFor(randomUUID()),
    );
    expect(response.status).toBe(404);
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
    mockClerk({ userId, orgId, orgRole: "org:admin" });
    const response = await POST(
      postRequest(`/${otherSession.id}/items`, itemBody()),
      paramsFor(otherSession.id),
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 when the role is invalid", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/items`, itemBody({ role: "invalid" })),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 when the body is missing", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const response = await POST(
      postRequest(`/${session.id}/items`),
      paramsFor(session.id),
    );
    expect(response.status).toBe(400);
  });

  it("appends a new item and returns the serialized row", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const realtimeItemId = randomUUID();
    const response = await POST(
      postRequest(
        `/${session.id}/items`,
        itemBody({ content: "first!", realtimeItemId }),
      ),
      paramsFor(session.id),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.item.sessionId).toBe(session.id);
    expect(body.item.role).toBe("user");
    expect(body.item.content).toBe("first!");
    expect(body.item.realtimeItemId).toBe(realtimeItemId);
    expect(body.item.seq).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent on duplicate realtimeItemId (silent dedupe, no extra seq, no extra reasoner tick)", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ orgId, userId, agentId });
    const realtimeItemId = randomUUID();
    const first = await POST(
      postRequest(
        `/${session.id}/items`,
        itemBody({ content: "dup", realtimeItemId }),
      ),
      paramsFor(session.id),
    );
    const firstBody = await first.json();
    expect(first.status).toBe(200);

    const second = await POST(
      postRequest(
        `/${session.id}/items`,
        itemBody({ content: "dup-retry", realtimeItemId }),
      ),
      paramsFor(session.id),
    );
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody.item.id).toBe(firstBody.item.id);
    expect(secondBody.item.seq).toBe(firstBody.item.seq);
    expect(secondBody.item.content).toBe("dup");
  });
});
