import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { POST } from "../route";
import { createTestSandboxToken } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { createProxyToken } from "../../../../../../src/lib/proxy/token-service";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { server } from "../../../../../../src/mocks/server";

// Mock external services (required by testContext)
vi.mock("@clerk/nextjs/server");
vi.mock("@e2b/code-interpreter");
vi.mock("@aws-sdk/client-s3");
vi.mock("@aws-sdk/s3-request-presigner");
vi.mock("@axiomhq/js");

const context = testContext();

describe("POST /api/webhooks/agent/proxy", () => {
  const testUserId = `test-user-proxy-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  let testToken: string;

  beforeEach(async () => {
    context.setupMocks();

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(testUserId, testRunId);

    // Mock Clerk auth to return null (webhook uses token auth)
    mockClerk({ userId: null });
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fhttpbin.org%2Fget&runId=${testRunId}`,
        { method: "POST" },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with invalid token", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fhttpbin.org%2Fget&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: "Bearer invalid-token" },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  // ============================================
  // URL Validation Tests
  // ============================================

  describe("URL Validation", () => {
    it("should reject request without url parameter", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toContain("url");
    });

    it("should reject request with invalid url", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=not-a-valid-url&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it("should reject request with non-http protocol", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=ftp%3A%2F%2Fexample.com&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    // SSRF Protection Tests
    it("should reject localhost URLs (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2Flocalhost%3A8080%2Fadmin&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject 127.0.0.1 URLs (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2F127.0.0.1%3A3000%2Fapi&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject AWS metadata URL (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject private network 10.x.x.x URLs (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2F10.0.0.1%2Finternal&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject private network 172.16.x.x URLs (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2F172.16.0.1%2Finternal&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject private network 192.168.x.x URLs (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2F192.168.1.1%2Finternal&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("should reject .internal hostnames (SSRF protection)", async () => {
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=http%3A%2F%2Fmetadata.google.internal%2F&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  // ============================================
  // Proxy Forwarding Tests
  // ============================================

  describe("Proxy Forwarding", () => {
    it("should forward request to target URL", async () => {
      let capturedRequest: Request | undefined;
      server.use(
        http.post("https://api.example.com/test", async ({ request }) => {
          capturedRequest = request.clone();
          return HttpResponse.json({ success: true });
        }),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.example.com%2Ftest&runId=${testRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: "test" }),
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest?.url).toBe("https://api.example.com/test");
      expect(capturedRequest?.method).toBe("POST");
    });

    it("should handle target URL with query parameters", async () => {
      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "https://api.example.com/v1/messages",
          async ({ request }) => {
            capturedRequest = request.clone();
            return HttpResponse.json({ ok: true });
          },
        ),
      );

      // URL with query params: https://api.example.com/v1/messages?stream=true
      const encodedUrl = encodeURIComponent(
        "https://api.example.com/v1/messages?stream=true&model=claude",
      );
      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=${encodedUrl}&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(capturedRequest?.url).toBe(
        "https://api.example.com/v1/messages?stream=true&model=claude",
      );
    });

    it("should return 502 when target is unreachable", async () => {
      server.use(
        http.post("https://unreachable.example.com/", () => {
          return HttpResponse.error();
        }),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Funreachable.example.com&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(502);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_GATEWAY");
    });
  });

  // ============================================
  // Header Forwarding Tests
  // ============================================

  describe("Header Forwarding", () => {
    it("should forward custom headers to target", async () => {
      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            capturedRequest = request.clone();
            return HttpResponse.json({});
          },
        ),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${testRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testToken}`,
            "Content-Type": "application/json",
            "X-Api-Key": "sk-ant-test-key",
            "anthropic-version": "2023-06-01",
          },
        },
      );

      await POST(request);

      // Should forward custom headers
      expect(capturedRequest?.headers.get("X-Api-Key")).toBe("sk-ant-test-key");
      expect(capturedRequest?.headers.get("anthropic-version")).toBe(
        "2023-06-01",
      );
      expect(capturedRequest?.headers.get("Content-Type")).toBe(
        "application/json",
      );
    });

    it("should not forward hop-by-hop headers", async () => {
      let capturedRequest: Request | undefined;
      server.use(
        http.post("https://api.example.com/", async ({ request }) => {
          capturedRequest = request.clone();
          return HttpResponse.json({});
        }),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.example.com&runId=${testRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${testToken}`,
            Host: "localhost:3000",
            Connection: "keep-alive",
          },
        },
      );

      await POST(request);

      // Should not forward hop-by-hop headers
      expect(capturedRequest?.headers.get("Host")).toBeNull();
      expect(capturedRequest?.headers.get("Connection")).toBeNull();
    });
  });

  // ============================================
  // SSE Streaming Tests
  // ============================================

  describe("SSE Streaming", () => {
    it("should pass through SSE content-type", async () => {
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () => {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode('data: {"type":"message"}\n\n'),
              );
              controller.close();
            },
          });
          return new HttpResponse(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          });
        }),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${testRunId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${testToken}` },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    });
  });

  // ============================================
  // Proxy Token Decryption Tests
  // ============================================

  describe("Proxy Token Decryption", () => {
    const proxyTestRunId = "run-test-123";
    const testSecretName = "ANTHROPIC_API_KEY";
    const testSecretValue = "sk-ant-real-api-key-12345";
    let proxyTestToken: string;

    beforeEach(async () => {
      // Generate a new JWT token for the proxyTestRunId
      proxyTestToken = await createTestSandboxToken(testUserId, proxyTestRunId);
    });

    it("should decrypt proxy token in Authorization header (Bearer format)", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            capturedRequest = request.clone();
            return HttpResponse.json({ success: true });
          },
        ),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${proxyTestRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxyTestToken}`,
            "Content-Type": "application/json",
            // The proxy token goes in the x-api-key for Anthropic
            "x-api-key": proxyToken,
          },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify the decrypted secret was sent to target
      expect(capturedRequest?.headers.get("x-api-key")).toBe(testSecretValue);
    });

    it("should decrypt proxy token in x-api-key header", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            capturedRequest = request.clone();
            return HttpResponse.json({ success: true });
          },
        ),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${proxyTestRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxyTestToken}`,
            "x-api-key": proxyToken,
          },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify the decrypted secret was sent to target
      expect(capturedRequest?.headers.get("x-api-key")).toBe(testSecretValue);
    });

    it("should pass through non-proxy tokens unchanged", async () => {
      const regularApiKey = "sk-ant-regular-api-key";

      let capturedRequest: Request | undefined;
      server.use(
        http.post(
          "https://api.anthropic.com/v1/messages",
          async ({ request }) => {
            capturedRequest = request.clone();
            return HttpResponse.json({ success: true });
          },
        ),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${proxyTestRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxyTestToken}`,
            "x-api-key": regularApiKey,
          },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(200);

      // Verify the regular API key was passed through unchanged
      expect(capturedRequest?.headers.get("x-api-key")).toBe(regularApiKey);
    });

    it("should return 401 when runId doesn't match", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      // Generate a token for different run
      const differentRunId = randomUUID();
      const differentRunToken = await createTestSandboxToken(
        testUserId,
        differentRunId,
      );

      // Track if fetch was called
      let fetchCalled = false;
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () => {
          fetchCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      const request = new NextRequest(
        // Different runId than what's in the proxy token
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${differentRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${differentRunToken}`,
            "x-api-key": proxyToken,
          },
        },
      );

      const response = await POST(request);

      // Should return 401 with clear error message instead of forwarding
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toContain("decryption failed");
      expect(data.error.header).toBe("x-api-key");

      // Should NOT have called fetch since decryption failed
      expect(fetchCalled).toBe(false);
    });

    it("should return 401 when proxy token is expired", async () => {
      // Create an expired token
      const expiredToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
        -1000, // expired 1 second ago
      );

      // Track if fetch was called
      let fetchCalled = false;
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () => {
          fetchCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      const request = new NextRequest(
        `http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages&runId=${proxyTestRunId}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxyTestToken}`,
            "x-api-key": expiredToken,
          },
        },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
      expect(data.error.message).toContain("decryption failed");

      // Should NOT have called fetch
      expect(fetchCalled).toBe(false);
    });

    it("should reject request without runId parameter (security)", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      // Track if fetch was called
      let fetchCalled = false;
      server.use(
        http.post("https://api.anthropic.com/v1/messages", () => {
          fetchCalled = true;
          return HttpResponse.json({ success: true });
        }),
      );

      const request = new NextRequest(
        // No runId in query params - should be rejected
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${proxyTestToken}`,
            "x-api-key": proxyToken,
          },
        },
      );

      const response = await POST(request);

      // runId is required to prevent token replay attacks
      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error.code).toBe("BAD_REQUEST");
      expect(data.error.message).toContain("runId");

      // Should not have made any fetch calls
      expect(fetchCalled).toBe(false);
    });
  });
});
