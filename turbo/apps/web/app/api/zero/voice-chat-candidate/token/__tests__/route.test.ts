import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import {
  seedCandidateAgent,
  seedCandidateSession,
  setupCandidateOrg,
} from "../../__tests__/_helpers";

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
  let orgId: string;
  let sessionId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const seeded = await setupCandidateOrg(userId);
    orgId = seeded.orgId;
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();

    const { agentId } = await seedCandidateAgent(userId, orgId);
    const session = await seedCandidateSession({ userId, orgId, agentId });
    sessionId = session.id;
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(tokenRequest({ sessionId }));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the voice-chat feature flag is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(tokenRequest({ sessionId }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("returns 400 when sessionId is missing", async () => {
    const response = await POST(tokenRequest({}));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the session does not exist", async () => {
    const response = await POST(
      tokenRequest({ sessionId: "00000000-0000-0000-0000-000000000000" }),
    );
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("mints an ephemeral token and presets session config on the upstream", async () => {
    interface UpstreamBody {
      model?: string;
      modalities?: unknown;
      instructions?: string;
      input_audio_transcription?: unknown;
      input_audio_noise_reduction?: unknown;
      turn_detection?: unknown;
      tools?: Array<{ name: string }>;
    }
    let received: UpstreamBody | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          received = (await request.json()) as UpstreamBody;
          return HttpResponse.json({
            client_secret: { value: "ek_test_value", expires_at: 9999999999 },
            model: received?.model,
          });
        },
      ),
    );
    const response = await POST(tokenRequest({ sessionId }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.client_secret.value).toBe("ek_test_value");
    expect(received?.model).toBe("gpt-realtime-mini");
    expect(received?.modalities).toEqual(["text", "audio"]);
    expect(typeof received?.instructions).toBe("string");
    expect(received?.instructions?.length ?? 0).toBeGreaterThan(0);
    expect(received?.input_audio_transcription).toEqual({
      model: "gpt-4o-mini-transcribe",
    });
    expect(received?.input_audio_noise_reduction).toEqual({
      type: "far_field",
    });
    expect(received?.turn_detection).toEqual({
      type: "semantic_vad",
      eagerness: "medium",
      interrupt_response: false,
    });
    const toolNames =
      received?.tools?.map((t) => {
        return t.name;
      }) ?? [];
    expect(toolNames).toContain("inform_slow_brain");
    expect(toolNames).toContain("feel_confused");
  });

  it("threads near_field noiseReduction through to the upstream body", async () => {
    interface UpstreamBody {
      input_audio_noise_reduction?: { type?: string };
    }
    let received: UpstreamBody | undefined;
    server.use(
      http.post(
        "https://api.openai.com/v1/realtime/sessions",
        async ({ request }) => {
          received = (await request.json()) as UpstreamBody;
          return HttpResponse.json({
            client_secret: { value: "ek_test", expires_at: 9999999999 },
          });
        },
      ),
    );
    const response = await POST(
      tokenRequest({ sessionId, noiseReduction: "near_field" }),
    );
    expect(response.status).toBe(200);
    expect(received?.input_audio_noise_reduction).toEqual({
      type: "near_field",
    });
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
    const response = await POST(tokenRequest({ sessionId }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
