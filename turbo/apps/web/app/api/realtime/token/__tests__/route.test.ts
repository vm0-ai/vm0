import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "../route";
import {
  createTestRequest,
  createTestCompose,
  createTestRun,
} from "../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../src/__tests__/clerk-mock";
import { reloadEnv } from "../../../../../src/env";

const { mockCreateTokenRequest } = vi.hoisted(() => {
  const mockCreateTokenRequest = vi.fn();
  vi.stubEnv("ABLY_API_KEY", "test-ably-key");
  return { mockCreateTokenRequest };
});

vi.mock("ably", () => ({
  default: {
    Rest: vi.fn(function () {
      return {
        auth: { createTokenRequest: mockCreateTokenRequest },
        channels: { get: () => ({ publish: vi.fn() }) },
      };
    }),
  },
}));

const context = testContext();

function postToken(runId: string) {
  return POST(
    createTestRequest("http://localhost:3000/api/realtime/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    }),
  );
}

describe("POST /api/realtime/token", () => {
  beforeEach(async () => {
    context.setupMocks();
    vi.stubEnv("ABLY_API_KEY", "test-ably-key");
    reloadEnv();
    await context.setupUser();
    mockCreateTokenRequest.mockReset();
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const response = await postToken("00000000-0000-0000-0000-000000000000");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when run does not exist", async () => {
    const response = await postToken("00000000-0000-0000-0000-000000000000");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("should return 403 when user does not own the run", async () => {
    const { composeId } = await createTestCompose("test-agent");
    const { runId } = await createTestRun(composeId, "test prompt");

    // Switch to a different user
    await context.setupUser({ prefix: "other-user" });

    const response = await postToken(runId);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("should return 500 when realtime service is unavailable", async () => {
    const { composeId } = await createTestCompose("test-agent");
    const { runId } = await createTestRun(composeId, "test prompt");

    mockCreateTokenRequest.mockRejectedValue(new Error("Ably unavailable"));

    const response = await postToken(runId);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("should return 200 with token request on success", async () => {
    const { composeId } = await createTestCompose("test-agent");
    const { runId } = await createTestRun(composeId, "test prompt");

    const mockTokenRequest = {
      keyName: "test-key",
      ttl: 3600000,
      timestamp: Date.now(),
      capability: JSON.stringify({ [`run:${runId}`]: ["subscribe"] }),
      clientId: "test-client",
      nonce: "test-nonce",
      mac: "test-mac",
    };
    mockCreateTokenRequest.mockResolvedValue(mockTokenRequest);

    const response = await postToken(runId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("error");
    expect(body.keyName).toBe("test-key");
    expect(body.nonce).toBe("test-nonce");
    expect(body.mac).toBe("test-mac");
  });
});
