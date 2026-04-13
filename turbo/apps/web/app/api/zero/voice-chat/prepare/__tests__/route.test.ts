import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  findTestZeroRun,
  insertTestVoiceChatPreparation,
  getTestZeroAgentId,
  getTestVoiceChatPreparation,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";

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

const BASE_URL = "http://localhost:3000/api/zero/voice-chat/prepare";

async function setupOrg(userId: string) {
  const slug = uniqueId("vcp");
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

describe("POST /api/zero/voice-chat/prepare", () => {
  let orgId: string;
  let userId: string;
  let agentId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const org = await setupOrg(userId);
    orgId = org.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
    const compose = await createTestCompose(uniqueId("vcp-agent"));
    agentId = await getTestZeroAgentId(orgId, compose.name);
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
    const response = await POST(createRequest({ agentId }));
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

  it("should return 400 when meeting mode lacks prompt", async () => {
    const response = await POST(createRequest({ agentId, mode: "meeting" }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return cached preparation when a fresh one exists", async () => {
    const preparationId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "cached directive",
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.id).toBe(preparationId);
    expect(body.preparation.status).toBe("ready");
  });

  it("should return in-flight preparation for dedup", async () => {
    const preparationId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "preparing",
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.id).toBe(preparationId);
    expect(body.preparation.status).toBe("preparing");
  });

  it("should create new preparation and dispatch run", async () => {
    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation).toBeDefined();
    expect(body.preparation.id).toBeDefined();
    expect(body.preparation.status).toBe("preparing");
    expect(body.preparation.runId).toBeDefined();

    // Verify preparation was created in database
    const prep = await getTestVoiceChatPreparation(body.preparation.id);
    expect(prep).toBeDefined();
    expect(prep?.status).toBe("preparing");
    expect(prep?.runId).toBe(body.preparation.runId);

    // Verify a zero run was dispatched
    const run = await findTestZeroRun(body.preparation.runId);
    expect(run).toBeDefined();
    expect(run?.triggerSource).toBe("voice-chat");
  });

  it("should create meeting preparation with prompt", async () => {
    const response = await POST(
      createRequest({
        agentId,
        mode: "meeting",
        prompt: "Review PR #42",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.status).toBe("preparing");

    const prep = await getTestVoiceChatPreparation(body.preparation.id);
    expect(prep?.mode).toBe("meeting");
    expect(prep?.prompt).toBe("Review PR #42");
  });
});
