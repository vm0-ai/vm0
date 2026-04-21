import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
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

  it("should return 409 when user has a preparing session", async () => {
    await createTestVoiceChatSession(orgId, userId, "preparing");
    const response = await POST(createRequest({ agentId: "any-agent-id" }));
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("should create session and dispatch slow-brain on success", async () => {
    const { agentId } = await createTestCompose(uniqueId("vc-agent"));

    const response = await POST(createRequest({ agentId }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.session).toBeDefined();
    expect(body.session.id).toBeDefined();
    expect(body.session.status).toBe("preparing");
    expect(body.session.runId).toBeDefined();
    expect(body.session.createdAt).toBeDefined();
    expect(body.session.prepared).toBe(false);

    const zeroRun = await findTestZeroRun(body.session.runId);
    expect(zeroRun?.triggerSource).toBe("voice-chat");

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
