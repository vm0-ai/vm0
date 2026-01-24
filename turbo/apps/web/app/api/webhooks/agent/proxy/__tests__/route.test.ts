import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { createProxyToken } from "../../../../../../src/lib/proxy/token-service";
import { createTestSandboxToken } from "../../../../../../src/__tests__/api-test-helpers";
import { randomUUID } from "crypto";

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock fetch for proxying
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  mockClerk,
  clearClerkMock,
} from "../../../../../../src/__tests__/clerk-mock";

describe("POST /api/webhooks/agent/proxy", () => {
  const testUserId = `test-user-proxy-${Date.now()}-${process.pid}`;
  const testRunId = randomUUID();
  let testToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Generate JWT token for sandbox auth
    testToken = await createTestSandboxToken(testUserId, testRunId);

    // Mock Clerk auth to return null (webhook uses token auth)
    mockClerk({ userId: null });
  });

  afterEach(async () => {
    clearClerkMock();
    // No cleanup needed for JWT tokens (stateless)
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
      const targetResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/test",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("should handle target URL with query parameters", async () => {
      const targetResponse = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.example.com/v1/messages?stream=true&model=claude",
        expect.anything(),
      );
    });

    it("should return 502 when target is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

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
      const targetResponse = new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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

      const fetchCall = mockFetch.mock.calls[0];
      const fetchHeaders = fetchCall?.[1]?.headers as Headers;

      // Should forward custom headers
      expect(fetchHeaders.get("X-Api-Key")).toBe("sk-ant-test-key");
      expect(fetchHeaders.get("anthropic-version")).toBe("2023-06-01");
      expect(fetchHeaders.get("Content-Type")).toBe("application/json");
    });

    it("should not forward hop-by-hop headers", async () => {
      const targetResponse = new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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

      const fetchCall = mockFetch.mock.calls[0];
      const fetchHeaders = fetchCall?.[1]?.headers as Headers;

      // Should not forward hop-by-hop headers
      expect(fetchHeaders.get("Host")).toBeNull();
      expect(fetchHeaders.get("Connection")).toBeNull();
    });
  });

  // ============================================
  // SSE Streaming Tests
  // ============================================

  describe("SSE Streaming", () => {
    it("should pass through SSE content-type", async () => {
      // Mock SSE response
      const sseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"type":"message"}\n\n'),
          );
          controller.close();
        },
      });

      const targetResponse = new Response(sseBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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

      const targetResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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
      const fetchCall = mockFetch.mock.calls[0];
      const fetchHeaders = fetchCall?.[1]?.headers as Headers;
      expect(fetchHeaders.get("x-api-key")).toBe(testSecretValue);
    });

    it("should decrypt proxy token in x-api-key header", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
      );

      const targetResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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
      const fetchCall = mockFetch.mock.calls[0];
      const fetchHeaders = fetchCall?.[1]?.headers as Headers;
      expect(fetchHeaders.get("x-api-key")).toBe(testSecretValue);
    });

    it("should pass through non-proxy tokens unchanged", async () => {
      const regularApiKey = "sk-ant-regular-api-key";

      const targetResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

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
      const fetchCall = mockFetch.mock.calls[0];
      const fetchHeaders = fetchCall?.[1]?.headers as Headers;
      expect(fetchHeaders.get("x-api-key")).toBe(regularApiKey);
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
      expect(mockFetch).not.toHaveBeenCalled();
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
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should reject request without runId parameter (security)", async () => {
      const proxyToken = createProxyToken(
        proxyTestRunId,
        testUserId,
        testSecretName,
        testSecretValue,
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
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
