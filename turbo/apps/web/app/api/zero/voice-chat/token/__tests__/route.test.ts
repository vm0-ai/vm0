import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";
import {
  insertTestUsagePricing,
  setOrgCredits,
} from "../../../../../../src/__tests__/api-test-helpers";
import {
  seedVoiceChatAgent,
  seedVoiceChatSession,
  setupVoiceChatOrg,
} from "../../__tests__/_helpers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { verifyRelayToken } from "@vm0/core/voice-chat/relay-token";
import {
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
} from "../../../../../../src/lib/zero/billing/model-usage-categories";

vi.mock("@vm0/core/feature-switch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@vm0/core/feature-switch")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn().mockReturnValue(false),
  };
});

vi.hoisted(() => {
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
});

const RELAY_SECRET = "ab".repeat(32);
const RELAY_API_URL = "https://api.example.test";

const { isFeatureEnabled } = await import("@vm0/core/feature-switch");
const mockIsFeatureEnabled = isFeatureEnabled as ReturnType<typeof vi.fn>;

const setFlags = (flags: Partial<Record<FeatureSwitchKey, boolean>>) => {
  mockIsFeatureEnabled.mockImplementation((key: FeatureSwitchKey) => {
    return flags[key] ?? false;
  });
};

const { POST } = await import("../route");

const context = testContext();

function tokenRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/zero/voice-chat/token", {
    method: "POST",
    ...(body && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
}

// Idempotent — `insertTestUsagePricing` upserts on conflict, so concurrent
// runs across this file and the candidate-route test file converge on the
// same set of rows. We deliberately do NOT delete pricing in afterEach:
// the shared `usage_pricing` table is global, and a concurrent delete
// would race the other file's read. The "missing pricing" branch is
// covered by sub-issue #12138's helper-level tests; here we exercise
// the success path.
async function seedRealtimePricing(): Promise<void> {
  for (const category of REALTIME_TOKEN_CATEGORIES) {
    await insertTestUsagePricing({
      kind: "model",
      provider: REALTIME_PROVIDER,
      category,
      unitPrice: 1,
      unitSize: 1_000_000,
    });
  }
  for (const category of TRANSCRIPTION_TOKEN_CATEGORIES) {
    await insertTestUsagePricing({
      kind: "model",
      provider: TRANSCRIPTION_PROVIDER,
      category,
      unitPrice: 1,
      unitSize: 1_000_000,
    });
  }
}

describe("POST /api/zero/voice-chat/token", () => {
  let userId: string;
  let orgId: string;
  let sessionId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const seeded = await setupVoiceChatOrg(userId);
    orgId = seeded.orgId;
    setFlags({ [FeatureSwitchKey.Trinity]: true });
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", RELAY_SECRET);
    vi.stubEnv("VM0_API_URL", RELAY_API_URL);
    reloadEnv();

    const { agentId } = await seedVoiceChatAgent(userId, orgId);
    const session = await seedVoiceChatSession({ userId, orgId, agentId });
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
    setFlags({ [FeatureSwitchKey.Trinity]: false });
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

  describe("legacy branch (VoiceChatRealtimeBilling = OFF)", () => {
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
              client_secret: {
                value: "ek_test_value",
                expires_at: 9999999999,
              },
              model: received?.model,
            });
          },
        ),
      );
      const response = await POST(tokenRequest({ sessionId }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.client_secret.value).toBe("ek_test_value");
      expect(body).not.toHaveProperty("relayToken");
      expect(received?.model).toBe("gpt-realtime-2");
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

  describe("relay branch (VoiceChatRealtimeBilling = ON)", () => {
    beforeEach(async () => {
      setFlags({
        [FeatureSwitchKey.Trinity]: true,
        [FeatureSwitchKey.VoiceChatRealtimeBilling]: true,
      });
      await seedRealtimePricing();
    });

    it("returns 402 INSUFFICIENT_CREDITS when the org has no spendable credits", async () => {
      await setOrgCredits(orgId, 0);
      const response = await POST(tokenRequest({ sessionId }));
      const body = await response.json();
      expect(response.status).toBe(402);
      expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
    });

    it("returns 503 NOT_CONFIGURED when the relay secret is missing", async () => {
      await setOrgCredits(orgId, 1000);
      vi.stubEnv("VOICE_CHAT_RELAY_TOKEN_SECRET", "");
      reloadEnv();
      const response = await POST(tokenRequest({ sessionId }));
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body.error.code).toBe("NOT_CONFIGURED");
      expect(body.error.message).toBe("Voice-chat relay is not configured");
    });

    it("returns a relay bootstrap with no client_secret and a verifiable token", async () => {
      await setOrgCredits(orgId, 1000);
      const response = await POST(
        tokenRequest({ sessionId, noiseReduction: "near_field" }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).not.toHaveProperty("client_secret");
      expect(body.relayUrl).toBe(`${RELAY_API_URL}/api/zero/voice-chat/relay`);
      expect(body.transport).toBe("websocket");
      expect(body.sessionId).toBe(sessionId);
      expect(typeof body.relayToken).toBe("string");
      expect(typeof body.expiresAt).toBe("number");

      const verified = verifyRelayToken(body.relayToken, RELAY_SECRET);
      expect(verified.ok).toBe(true);
      if (!verified.ok) throw new Error("expected ok");
      expect(verified.claims.voiceChatSessionId).toBe(sessionId);
      expect(verified.claims.userId).toBe(userId);
      expect(verified.claims.orgId).toBe(orgId);
      expect(verified.claims.noiseReduction).toBe("near_field");
      expect(verified.claims.exp).toBe(body.expiresAt);
      expect(verified.claims.exp - verified.claims.iat).toBe(60);
      const nowSeconds = Math.floor(Date.now() / 1000);
      expect(Math.abs(verified.claims.iat - nowSeconds)).toBeLessThan(5);
    });
  });
});
