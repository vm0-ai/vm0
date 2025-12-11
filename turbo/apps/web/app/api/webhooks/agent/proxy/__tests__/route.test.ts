/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../route";
import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../../src/db/schema/cli-tokens";
import { eq } from "drizzle-orm";

// Mock Next.js headers() function
vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Mock Clerk auth
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(),
}));

// Mock fetch for proxying
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";

const mockHeaders = vi.mocked(headers);
const mockAuth = vi.mocked(auth);

describe("POST /api/webhooks/agent/proxy", () => {
  const testUserId = `test-user-proxy-${Date.now()}-${process.pid}`;
  const testToken = `vm0_live_proxy_test_${Date.now()}_${process.pid}`;

  beforeEach(async () => {
    vi.clearAllMocks();
    initServices();

    // Mock Clerk auth to return null (webhook uses token auth)
    mockAuth.mockResolvedValue({ userId: null } as unknown as Awaited<
      ReturnType<typeof auth>
    >);

    // Default: no auth header
    mockHeaders.mockResolvedValue({
      get: vi.fn().mockReturnValue(null),
    } as unknown as Headers);

    // Clean up test tokens
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));
  });

  afterEach(async () => {
    await globalThis.services.db
      .delete(cliTokens)
      .where(eq(cliTokens.token, testToken));
  });

  // ============================================
  // Authentication Tests
  // ============================================

  describe("Authentication", () => {
    it("should reject request without authentication", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fhttpbin.org%2Fget",
        { method: "POST" },
      );

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error.code).toBe("UNAUTHORIZED");
    });

    it("should reject request with invalid token", async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue("Bearer vm0_live_invalid_token"),
      } as unknown as Headers);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fhttpbin.org%2Fget",
        {
          method: "POST",
          headers: { Authorization: "Bearer vm0_live_invalid_token" },
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
    beforeEach(async () => {
      // Setup valid token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should reject request without url parameter", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/proxy",
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
        "http://localhost:3000/api/webhooks/agent/proxy?url=not-a-valid-url",
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
        "http://localhost:3000/api/webhooks/agent/proxy?url=ftp%3A%2F%2Fexample.com",
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
    beforeEach(async () => {
      // Setup valid token
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should forward request to target URL", async () => {
      const targetResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.example.com%2Ftest",
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
        `http://localhost:3000/api/webhooks/agent/proxy?url=${encodedUrl}`,
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
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Funreachable.example.com",
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
    beforeEach(async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

    it("should forward custom headers to target", async () => {
      const targetResponse = new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      mockFetch.mockResolvedValueOnce(targetResponse);

      const request = new NextRequest(
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
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
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.example.com",
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
    beforeEach(async () => {
      mockHeaders.mockResolvedValue({
        get: vi.fn().mockReturnValue(`Bearer ${testToken}`),
      } as unknown as Headers);

      await globalThis.services.db.insert(cliTokens).values({
        token: testToken,
        userId: testUserId,
        name: "Test Token",
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
      });
    });

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
        "http://localhost:3000/api/webhooks/agent/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages",
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
});
