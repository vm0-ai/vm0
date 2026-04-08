import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestVoiceChatSession,
  insertTestAgentCompose,
  createTestRunInDb,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import * as zeroRunModule from "../../../../../src/lib/zero/zero-run-service";

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
  let createZeroRunSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
    createZeroRunSpy = vi
      .spyOn(zeroRunModule, "createZeroRun")
      .mockResolvedValue({
        runId: "placeholder",
        status: "pending",
        createdAt: new Date(),
      });
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
    const agent = await insertTestAgentCompose(userId, orgId, "test-agent");
    const response = await POST(createRequest({ agentId: agent.id }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("should create session and dispatch worker on success", async () => {
    const agent = await insertTestAgentCompose(userId, orgId, "test-agent");

    // Pre-create a real run record so the FK constraint is satisfied
    const { runId } = await createTestRunInDb(userId, agent.id, {
      triggerSource: "voice-chat",
    });
    createZeroRunSpy.mockResolvedValue({
      runId,
      status: "pending",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const response = await POST(createRequest({ agentId: agent.id }));
    const body = await response.json();

    // Verify response shape
    expect(response.status).toBe(200);
    expect(body.session).toBeDefined();
    expect(body.session.id).toBeDefined();
    expect(body.session.status).toBe("active");
    expect(body.session.runId).toBe(runId);
    expect(body.session.createdAt).toBeDefined();

    // Verify createZeroRun was called with correct params
    expect(createZeroRunSpy).toHaveBeenCalledOnce();
    const callArgs = createZeroRunSpy.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.agentId).toBe(agent.id);
    expect(callArgs.userId).toBe(userId);
    expect(callArgs.triggerSource).toBe("voice-chat");

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
});
