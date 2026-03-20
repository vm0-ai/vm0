import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { server } from "../../../../../../src/mocks/server";

const context = testContext();

const SESSION_ID = "test-session-id-001";
const BASE_URL = `http://localhost:3000/api/zero/sessions/${SESSION_ID}`;
const INFRA_URL = `http://localhost:3000/api/agent/sessions/${SESSION_ID}`;

const mockSessionResponse = {
  id: SESSION_ID,
  agentComposeId: "compose-001",
  conversationId: "conv-001",
  artifactName: null,
  secretNames: [],
  chatMessages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("GET /api/zero/sessions/:id", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should proxy 200 response from infra endpoint", async () => {
    server.use(
      http.get(INFRA_URL, () => {
        return HttpResponse.json(mockSessionResponse, { status: 200 });
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.id).toBe(SESSION_ID);
    expect(data.agentComposeId).toBe("compose-001");
  });

  it("should proxy 401 response from infra endpoint", async () => {
    server.use(
      http.get(INFRA_URL, () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer invalid-token" },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should proxy 403 response from infra endpoint", async () => {
    server.use(
      http.get(INFRA_URL, () => {
        return HttpResponse.json(
          { error: { message: "Forbidden", code: "FORBIDDEN" } },
          { status: 403 },
        );
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error.code).toBe("FORBIDDEN");
  });

  it("should proxy 404 response from infra endpoint", async () => {
    server.use(
      http.get(INFRA_URL, () => {
        return HttpResponse.json(
          { error: { message: "Session not found", code: "NOT_FOUND" } },
          { status: 404 },
        );
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error.code).toBe("NOT_FOUND");
  });

  it("should forward authorization header to infra endpoint", async () => {
    let capturedAuthHeader: string | null = null;

    server.use(
      http.get(INFRA_URL, ({ request }) => {
        capturedAuthHeader = request.headers.get("authorization");
        return HttpResponse.json(mockSessionResponse, { status: 200 });
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer my-secret-token" },
    });
    await GET(request);

    expect(capturedAuthHeader).toBe("Bearer my-secret-token");
  });

  it("should map unexpected status codes to 404", async () => {
    server.use(
      http.get(INFRA_URL, () => {
        return HttpResponse.json(
          { error: { message: "Server error", code: "INTERNAL_SERVER_ERROR" } },
          { status: 500 },
        );
      }),
    );

    const request = createTestRequest(BASE_URL, {
      headers: { authorization: "Bearer test-token" },
    });
    const response = await GET(request);

    // The proxy maps any unhandled status to 404 (the fallback)
    expect(response.status).toBe(404);
  });
});
