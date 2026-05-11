import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { insertTestVoiceChatSession } from "../../../../../src/__tests__/db-test-seeders/voice-chat";
import {
  getRequest,
  postRequest,
  seedVoiceChatAgent,
  setupVoiceChatOrg,
} from "./_helpers";

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

const { GET, POST } = await import("../route");

const context = testContext();

describe("POST /api/zero/voice-chat (createSession)", () => {
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
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
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

describe("GET /api/zero/voice-chat (listSessions)", () => {
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

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when authenticated without an active org", async () => {
    mockClerk({ userId, orgId: null });

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns an empty list when the user has no voice-chat sessions", async () => {
    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ sessions: [] });
  });

  it("returns sessions ordered by createdAt desc", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const olderId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId,
      createdAt: new Date(Date.now() - 100_000),
    });
    const newerId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId,
      createdAt: new Date(Date.now() - 10_000),
    });

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].id).toBe(newerId);
    expect(body.sessions[1].id).toBe(olderId);
  });

  it("does not include sessions belonging to a different user in the same org", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const visibleId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId,
    });
    await insertTestVoiceChatSession({
      orgId,
      userId: `other-user-${randomUUID()}`,
      agentId,
    });

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(visibleId);
  });

  it("does not include sessions belonging to a different org", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const visibleId = await insertTestVoiceChatSession({
      orgId,
      userId,
      agentId,
    });
    await insertTestVoiceChatSession({
      orgId: `org_other_${randomUUID()}`,
      userId,
      agentId,
    });

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe(visibleId);
  });

  it("returns more than 50 matching sessions", async () => {
    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    for (let index = 0; index < 51; index += 1) {
      await insertTestVoiceChatSession({
        orgId,
        userId,
        agentId,
        createdAt: new Date(Date.now() - index * 1000),
      });
    }

    const response = await GET(getRequest(""));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(51);
  });
});
