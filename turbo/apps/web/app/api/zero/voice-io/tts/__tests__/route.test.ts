import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { createTestOrg } from "../../../../../../src/__tests__/api-test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../../src/env";

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
  const slug = uniqueId("zvio");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function ttsRequest(body?: unknown) {
  return new Request("http://localhost:3000/api/zero/voice-io/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/zero/voice-io/tts", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await POST(ttsRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature switch is disabled", async () => {
    const userId = uniqueId("zvio-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);

    const response = await POST(ttsRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 400 when text is empty", async () => {
    const userId = uniqueId("zvio-empty");
    await setupOrg(userId);

    const response = await POST(ttsRequest({ text: "" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 when text exceeds max length", async () => {
    const userId = uniqueId("zvio-long");
    await setupOrg(userId);

    const response = await POST(ttsRequest({ text: "x".repeat(4097) }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("4096");
  });

  it("should return 503 when OPENAI_API_KEY is not configured", async () => {
    const userId = uniqueId("zvio-nokey");
    await setupOrg(userId);
    vi.stubEnv("OPENAI_API_KEY", "");
    reloadEnv();

    const response = await POST(ttsRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("should return audio on successful TTS call", async () => {
    const userId = uniqueId("zvio-ok");
    await setupOrg(userId);

    const fakeAudio = new Uint8Array([0x00, 0x01, 0x00, 0x02]);

    server.use(
      http.post(
        "https://api.openai.com/v1/audio/speech",
        async ({ request }) => {
          const reqBody = (await request.json()) as Record<string, unknown>;
          expect(reqBody.model).toBe("gpt-4o-mini-tts");
          expect(reqBody.voice).toBe("ash");
          expect(reqBody.input).toBe("hello world");
          expect(reqBody.response_format).toBe("pcm");

          return new HttpResponse(fakeAudio, {
            headers: { "Content-Type": "application/octet-stream" },
          });
        },
      ),
    );

    const response = await POST(ttsRequest({ text: "hello world" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );

    const buffer = await response.arrayBuffer();
    expect(new Uint8Array(buffer)).toEqual(fakeAudio);
  });

  it("should return 500 when OpenAI API fails", async () => {
    const userId = uniqueId("zvio-fail");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/speech", () => {
        return HttpResponse.json(
          { error: "rate_limit_exceeded" },
          { status: 429 },
        );
      }),
    );

    const response = await POST(ttsRequest({ text: "hello" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
