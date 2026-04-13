import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../../../../src/mocks/server";
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

const { POST } = await import("../route");

const context = testContext();

async function setupOrg(userId: string) {
  const slug = uniqueId("stt");
  const orgId = `org_mock_${userId}`;
  mockClerk({ userId, orgId, orgRole: "org:admin" });
  await createTestOrg(slug);
  return { slug, orgId };
}

function createAudioFile(
  size = 1024,
  type = "audio/webm",
  name = "recording.webm",
): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

function createSttRequest(file?: File): Request {
  const formData = new FormData();
  if (file) formData.append("file", file);
  return new Request("http://localhost:3000/api/zero/voice-io/stt", {
    method: "POST",
    body: formData,
  });
}

describe("POST /api/zero/voice-io/stt", () => {
  beforeEach(() => {
    context.setupMocks();
    mockIsFeatureEnabled.mockReturnValue(true);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    reloadEnv();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 403 when feature flag is disabled", async () => {
    const userId = uniqueId("stt-ff");
    await setupOrg(userId);
    mockIsFeatureEnabled.mockReturnValue(false);
    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 503 when OPENAI_API_KEY is not configured", async () => {
    const userId = uniqueId("stt-nokey");
    await setupOrg(userId);
    vi.stubEnv("OPENAI_API_KEY", "");
    reloadEnv();
    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("should return 400 when no file is provided", async () => {
    const userId = uniqueId("stt-nofile");
    await setupOrg(userId);
    const response = await POST(createSttRequest());
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for unsupported file type", async () => {
    const userId = uniqueId("stt-badtype");
    await setupOrg(userId);
    const file = createAudioFile(1024, "text/plain", "notes.txt");
    const response = await POST(createSttRequest(file));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return 400 for file exceeding 25MB", async () => {
    const userId = uniqueId("stt-big");
    await setupOrg(userId);
    const file = createAudioFile(26 * 1024 * 1024);
    const response = await POST(createSttRequest(file));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("should return transcribed text on success", async () => {
    const userId = uniqueId("stt-ok");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json({ text: "Hello, world!" });
      }),
    );

    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.text).toBe("Hello, world!");
  });

  it("should return 500 when OpenAI API fails", async () => {
    const userId = uniqueId("stt-fail");
    await setupOrg(userId);

    server.use(
      http.post("https://api.openai.com/v1/audio/transcriptions", () => {
        return HttpResponse.json(
          { error: { message: "rate limit exceeded" } },
          { status: 429 },
        );
      }),
    );

    const response = await POST(createSttRequest(createAudioFile()));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
