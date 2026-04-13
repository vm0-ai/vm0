import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTestRequest,
  createTestOrg,
  createTestCompose,
  findTestZeroRun,
  insertTestVoiceChatPreparation,
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
  const slug = uniqueId("zvcp");
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

  it("should return 400 when meeting mode has no prompt", async () => {
    const response = await POST(
      createRequest({ agentId: "any-agent-id", mode: "meeting" }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should create a new preparation and dispatch run", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-new"));

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation).toBeDefined();
    expect(body.preparation.id).toBeDefined();
    expect(body.preparation.status).toBe("preparing");
    expect(body.preparation.runId).toBeDefined();

    // Verify run was created with correct trigger source
    const zeroRun = await findTestZeroRun(body.preparation.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");

    // Verify preparation record was created
    const prep = await getTestVoiceChatPreparation(body.preparation.id);
    expect(prep).toBeDefined();
    expect(prep!.status).toBe("preparing");
    expect(prep!.runId).toBe(body.preparation.runId);
  });

  it("should return fresh preparation on cache hit", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-cache"));

    const prepId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "Cached directive content.",
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.id).toBe(prepId);
    expect(body.preparation.status).toBe("ready");
  });

  it("should return in-flight preparation instead of creating duplicate", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-inflight"));

    const prepId = await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "preparing",
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.id).toBe(prepId);
    expect(body.preparation.status).toBe("preparing");
  });

  it("should not return stale preparation as cache hit", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-stale"));

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "Old cached directive.",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    // Should create a new preparation, not return the stale one
    expect(body.preparation.status).toBe("preparing");
    expect(body.preparation.runId).toBeDefined();
  });

  it("should create meeting preparation with prompt", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-meeting"));
    const meetingPrompt = "Review PR #123 changes";

    const response = await POST(
      createRequest({ agentId, mode: "meeting", prompt: meetingPrompt }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preparation.status).toBe("preparing");
    expect(body.preparation.runId).toBeDefined();

    const prep = await getTestVoiceChatPreparation(body.preparation.id);
    expect(prep!.mode).toBe("meeting");
    expect(prep!.prompt).toBe(meetingPrompt);
  });

  it("should return meeting cache hit only for matching prompt", async () => {
    const { agentId } = await createTestCompose(uniqueId("prep-meet-match"));
    const meetingPrompt = "Review PR #456";

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "meeting",
      prompt: meetingPrompt,
      status: "ready",
      directiveContent: "Meeting preparation summary.",
    });

    // Same prompt — cache hit
    const res1 = await POST(
      createRequest({ agentId, mode: "meeting", prompt: meetingPrompt }),
    );
    const body1 = await res1.json();
    expect(body1.preparation.status).toBe("ready");

    // Different prompt — cache miss
    const res2 = await POST(
      createRequest({ agentId, mode: "meeting", prompt: "Different topic" }),
    );
    const body2 = await res2.json();
    expect(body2.preparation.status).toBe("preparing");
  });
});
