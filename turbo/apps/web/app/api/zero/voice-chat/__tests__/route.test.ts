import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../src/mocks/server";
import { POST } from "../token/route";
import {
  testContext,
  uniqueId,
} from "../../../../../src/__tests__/test-helpers";
import { createTestOrg } from "../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

vi.mock("@vm0/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vm0/core")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(true),
  };
});

const { isFeatureEnabled } = await import("@vm0/core");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("zvc");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
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

describe("POST /api/zero/voice-chat/token", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("zvc-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await POST(tokenRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 503 when OPENAI_API_KEY is not configured", async () => {
    const userId = uniqueId("zvc-nokey");
    await setupOrg(userId);
    vi.stubEnv("OPENAI_API_KEY", "");
    reloadEnv();

    const response = await POST(tokenRequest());
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

    const response = await POST(tokenRequest());
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

    const response = await POST(tokenRequest());
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

    const response = await POST(tokenRequest({ model: "gpt-realtime-mini" }));

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime-mini");
  });

  it("should default to gpt-realtime when no model is provided", async () => {
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

    const response = await POST(tokenRequest());

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime");
  });

  it("should fall back to gpt-realtime for invalid model", async () => {
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

    const response = await POST(tokenRequest({ model: "invalid-model" }));

    expect(response.status).toBe(200);
    expect(capturedModel).toBe("gpt-realtime");
  });
});
