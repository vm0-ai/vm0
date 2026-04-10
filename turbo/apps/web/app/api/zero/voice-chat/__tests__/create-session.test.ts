import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestVoiceChatSession,
  createTestCompose,
  findTestZeroRun,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";

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
const { GET: getContext } = await import("../[id]/context/route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

async function setupOrg(userId: string) {
  const slug = uniqueId("zvcs");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function createRequest(body?: unknown) {
  return createTestRequest(BASE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function contextRequest(sessionId: string) {
  return createTestRequest(
    `http://localhost:3000/api/zero/voice-chat/${sessionId}/context`,
  );
}

function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/zero/voice-chat (create session)", () => {
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

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(createRequest({ agentId: "any" }));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(createRequest({ agentId: "any" }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 when agentId is missing", async () => {
    const response = await POST(createRequest({}));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when agentId is empty string", async () => {
    const response = await POST(createRequest({ agentId: "" }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 409 when user already has an active session", async () => {
    await createTestVoiceChatSession(orgId, userId);
    const response = await POST(createRequest({ agentId: "any-agent-id" }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("should create session and dispatch slow-brain on success", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-agent"));

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    // Verify response shape
    expect(response.status).toBe(200);
    expect(body.session).toBeDefined();
    expect(body.session.id).toBeDefined();
    expect(body.session.status).toBe("active");
    expect(body.session.mode).toBe("chat");
    expect(body.session.runId).toBeDefined();
    expect(body.session.createdAt).toBeDefined();

    // Verify run was created with correct trigger source
    const zeroRun = await findTestZeroRun(body.session.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");

    // Verify session-start event was written via context GET endpoint
    const ctxResponse = await getContext(
      contextRequest(body.session.id),
      paramsFor(body.session.id),
    );
    const ctxBody = await ctxResponse.json();
    expect(ctxResponse.status).toBe(200);
    expect(ctxBody.events).toHaveLength(1);
    expect(ctxBody.events[0].source).toBe("system");
    expect(ctxBody.events[0].type).toBe("session-start");
  });

  it("should create meeting session with preparing status", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-meeting"));

    const response = await POST(
      createRequest({
        agentId,
        mode: "meeting",
        prompt: "Review PR #123 before standup",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.status).toBe("preparing");
    expect(body.session.mode).toBe("meeting");
    expect(body.session.runId).toBeDefined();
  });

  it("should return 400 when meeting mode has no prompt", async () => {
    const response = await POST(
      createRequest({ agentId: "any-agent-id", mode: "meeting" }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 409 when user has a preparing session", async () => {
    await createTestVoiceChatSession(orgId, userId, "preparing");
    const response = await POST(createRequest({ agentId: "any-agent-id" }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });
});
