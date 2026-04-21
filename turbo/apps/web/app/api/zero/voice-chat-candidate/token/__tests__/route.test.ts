import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import { setupCandidateOrg } from "../../__tests__/_helpers";

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

const context = testContext();

function tokenRequest(body?: Record<string, unknown>): Request {
  return new Request(
    "http://localhost:3000/api/zero/voice-chat-candidate/token",
    {
      method: "POST",
      ...(body && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    },
  );
}

describe("POST /api/zero/voice-chat-candidate/token", () => {
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    await setupCandidateOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(tokenRequest());
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(tokenRequest());
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("mints an ephemeral token with the default model when no body is sent", async () => {
    let receivedModel: string | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          const json = (await request.json()) as { model?: string };
          receivedModel = json.model;
          return HttpResponse.json({
            client_secret: { value: "ek_test_value", expires_at: 9999999999 },
            model: json.model,
          });
        },
      ),
    );
    const response = await POST(tokenRequest());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.client_secret.value).toBe("ek_test_value");
    expect(receivedModel).toBeTruthy();
  });

  it("mints an ephemeral token with an explicit model override", async () => {
    let receivedModel: string | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          const json = (await request.json()) as { model?: string };
          receivedModel = json.model;
          return HttpResponse.json({
            client_secret: { value: "ek_override", expires_at: 9999999999 },
            model: json.model,
          });
        },
      ),
    );
    const response = await POST(tokenRequest({ model: "gpt-realtime-mini" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.client_secret.value).toBe("ek_override");
    expect(receivedModel).toBe("gpt-realtime-mini");
  });

  it("returns 500 when OpenAI returns an error", async () => {
    server.use(
      http.post("https://api.openai.com/v1/realtime/sessions", () => {
        return HttpResponse.json(
          { error: { message: "bad" } },
          { status: 400 },
        );
      }),
    );
    const response = await POST(tokenRequest());
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
