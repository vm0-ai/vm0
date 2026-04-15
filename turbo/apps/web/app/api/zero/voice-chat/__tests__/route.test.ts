import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import {
  createTestRequest,
  createTestOrg,
  createTestVoiceChatSession,
  createTestCompose,
  findTestZeroRun,
  insertTestVoiceChatPreparation,
  getTestVoiceChatEvents,
} from "../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const { POST } = await import("../route");
const { GET: getContext } = await import("../[id]/context/route");
const { POST: tokenPOST } = await import("../token/route");

const context = testContext();

const BASE_URL = "http://localhost:3000/api/zero/voice-chat";

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc");
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

function tokenRequest(body?: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/zero/voice-chat/token", {
    method: "POST",
    ...(body && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
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
    expect(body.session.status).toBe("preparing");
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

  it("should create meeting session with preparing status and meeting-prompt event", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-meeting"));
    const meetingPrompt = "Review PR #123 before standup";

    const response = await POST(
      createRequest({
        agentId,
        mode: "meeting",
        prompt: meetingPrompt,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.status).toBe("preparing");
    expect(body.session.mode).toBe("meeting");
    expect(body.session.runId).toBeDefined();

    // Verify meeting-prompt event was written before session-start
    const ctxResponse = await getContext(
      contextRequest(body.session.id),
      paramsFor(body.session.id),
    );
    const ctxBody = await ctxResponse.json();
    expect(ctxBody.events).toHaveLength(2);
    expect(ctxBody.events[0].source).toBe("user");
    expect(ctxBody.events[0].type).toBe("meeting-prompt");
    expect(ctxBody.events[0].content).toBe(meetingPrompt);
    expect(ctxBody.events[1].source).toBe("system");
    expect(ctxBody.events[1].type).toBe("session-start");
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

  it("should return prepared: true when fresh preparation cache exists", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-cache-hit"));

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "Cached directive for the fast-brain.",
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.prepared).toBe(true);
    expect(body.session.runId).toBeDefined();

    // Verify cached events were written (thinking + directive + preparation-ready + session-start)
    const events = await getTestVoiceChatEvents(body.session.id);
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      source: "slow-brain",
      type: "thinking",
    });
    expect(events[1]).toMatchObject({
      source: "slow-brain",
      type: "directive",
      content: "Cached directive for the fast-brain.",
    });
    expect(events[2]).toMatchObject({
      source: "slow-brain",
      type: "preparation-ready",
    });
    expect(events[3]).toMatchObject({
      source: "system",
      type: "session-start",
    });
  });

  it("should return prepared: false when no preparation cache exists", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-cache-miss"));

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.prepared).toBe(false);
    expect(body.session.runId).toBeDefined();

    // Verify only session-start event (normal flow)
    const events = await getTestVoiceChatEvents(body.session.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "system",
      type: "session-start",
    });
  });

  it("should return prepared: false when preparation is stale", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-stale"));

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "chat",
      status: "ready",
      directiveContent: "Old cached directive.",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
    });

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.prepared).toBe(false);
  });

  it("should return prepared: true for meeting mode with matching prompt", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-meeting-hit"));
    const meetingPrompt = "Review PR #456 changes";

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "meeting",
      prompt: meetingPrompt,
      status: "ready",
      directiveContent: "Meeting preparation summary.",
    });

    const response = await POST(
      createRequest({ agentId, mode: "meeting", prompt: meetingPrompt }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.prepared).toBe(true);
  });

  it("should return prepared: false for meeting mode with different prompt", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-meeting-miss"));

    await insertTestVoiceChatPreparation({
      orgId,
      userId,
      agentId,
      mode: "meeting",
      prompt: "Review PR #123",
      status: "ready",
      directiveContent: "Different meeting preparation.",
    });

    const response = await POST(
      createRequest({
        agentId,
        mode: "meeting",
        prompt: "Review PR #789",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session.prepared).toBe(false);
  });
});

describe("POST /api/zero/voice-chat/token", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await tokenPOST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("zvc-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await tokenPOST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 503 when OPENAI_API_KEY is not configured", async () => {
    const userId = uniqueId("zvc-nokey");
    await setupOrg(userId);
    vi.stubEnv("OPENAI_API_KEY", "");
    reloadEnv();

    const response = await tokenPOST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("should return ephemeral token on success", async () => {
    const userId = uniqueId("zvc-ok");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/realtime/sessions", () => {
        return HttpResponse.json({
          client_secret: {
            value: "eph_test_token_123",
            expires_at: 1700000000,
          },
        });
      }),
    );

    const response = await tokenPOST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.client_secret.value).toBe("eph_test_token_123");
    expect(body.client_secret.expires_at).toBe(1700000000);
  });

  it("should return 500 when OpenAI API fails", async () => {
    const userId = uniqueId("zvc-fail");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/realtime/sessions", () => {
        return HttpResponse.json(
          { error: "rate_limit_exceeded" },
          { status: 429 },
        );
      }),
    );

    const response = await tokenPOST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should pass explicit model to OpenAI API", async () => {
    const userId = uniqueId("zvc-model");
    await setupOrg(userId);

    let capturedModel: string | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          const reqBody = (await request.json()) as { model?: string };
          capturedModel = reqBody.model;
          return HttpResponse.json({
            client_secret: {
              value: "eph_mini_token",
              expires_at: 1700000000,
            },
          });
        },
      ),
    );

    const response = await tokenPOST(
      tokenRequest({ model: "gpt-realtime-mini" }),
    );

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime-mini");
  });

  it("should default to gpt-realtime-mini when no model is provided", async () => {
    const userId = uniqueId("zvc-nomodel");
    await setupOrg(userId);

    let capturedModel: string | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          const reqBody = (await request.json()) as { model?: string };
          capturedModel = reqBody.model;
          return HttpResponse.json({
            client_secret: {
              value: "eph_default_token",
              expires_at: 1700000000,
            },
          });
        },
      ),
    );

    const response = await tokenPOST(tokenRequest());

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime-mini");
  });

  it("should fall back to gpt-realtime-mini for invalid model", async () => {
    const userId = uniqueId("zvc-invalid");
    await setupOrg(userId);

    let capturedModel: string | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          const reqBody = (await request.json()) as { model?: string };
          capturedModel = reqBody.model;
          return HttpResponse.json({
            client_secret: {
              value: "eph_fallback_token",
              expires_at: 1700000000,
            },
          });
        },
      ),
    );

    const response = await tokenPOST(tokenRequest({ model: "invalid-model" }));

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime-mini");
  });
});
