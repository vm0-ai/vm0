import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { handleCors } from "../middleware.cors";

// Mock the env module
vi.mock("../middleware.cors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../middleware.cors")>();
  return {
    ...actual,
  };
});

vi.mock("../src/env", () => ({
  env: vi.fn(),
}));

import { env } from "../src/env";

describe("handleCors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Production Environment (VERCEL_ENV=production)", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "production",
      } as ReturnType<typeof env>);
    });

    it("should accept exact match: https://www.vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm0.ai",
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should accept exact match: https://vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0.ai",
      );
    });

    it("should accept *.vm0.ai subdomain: https://platform.vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });

    it("should accept any *.vm0.ai subdomain", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://any-subdomain.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-subdomain.vm0.ai",
      );
    });

    it("should reject *.vercel.app origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://example-app.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject localhost origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject invalid origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("Preview Environment (VERCEL_ENV=preview)", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "preview",
      } as ReturnType<typeof env>);
    });

    it("should accept production domain: https://www.vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm0.ai",
      );
    });

    it("should accept *.vm0.ai subdomain: https://platform.vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });

    it("should accept *.vercel.app origin: https://vm0-platform-abc123.vercel.app", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0-platform-abc123.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0-platform-abc123.vercel.app",
      );
    });

    it("should accept any *.vercel.app subdomain", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://any-app-xyz.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-app-xyz.vercel.app",
      );
    });

    it("should reject localhost origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject invalid origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("Development Environment (VERCEL_ENV=development)", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "development",
      } as ReturnType<typeof env>);
    });

    it("should accept production domain: https://www.vm0.ai", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm0.ai",
      );
    });

    it("should accept localhost:3000", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("should accept localhost:5173", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:5173" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:5173",
      );
    });

    it("should accept localhost with any port", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:8080" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:8080",
      );
    });

    it("should accept *.vercel.app origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0-platform-abc.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0-platform-abc.vercel.app",
      );
    });

    it("should reject invalid origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("Undefined Environment (VERCEL_ENV=undefined, treats as development)", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: undefined,
      } as ReturnType<typeof env>);
    });

    it("should accept localhost origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("should accept *.vercel.app origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://test-app.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://test-app.vercel.app",
      );
    });

    it("should accept *.vm0.ai subdomain", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });
  });

  describe("Edge Cases", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "production",
      } as ReturnType<typeof env>);
    });

    it("should reject null origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs");

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject undefined origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: {},
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should handle malformed origin URL gracefully", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "not-a-valid-url" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should handle origin with unusual port", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai:8443" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai:8443",
      );
    });

    it("should handle HTTP vs HTTPS correctly", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://platform.vm0.ai",
      );
    });

    it("should handle case sensitivity in hostname (lowercase vercel.app)", () => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "preview",
      } as ReturnType<typeof env>);

      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://test-app.VERCEL.APP" },
      });

      const response = handleCors(request);

      // URL hostname is automatically lowercased by URL constructor
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://test-app.VERCEL.APP",
      );
    });
  });

  describe("Preflight Request Tests (OPTIONS)", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "production",
      } as ReturnType<typeof env>);
    });

    it("should handle OPTIONS request with correct headers", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "OPTIONS",
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
        "Authorization",
      );
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    });

    it("should handle OPTIONS request in preview environment", () => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "preview",
      } as ReturnType<typeof env>);

      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "OPTIONS",
        headers: { origin: "https://test-app.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://test-app.vercel.app",
      );
    });

    it("should handle OPTIONS request in development environment", () => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "development",
      } as ReturnType<typeof env>);

      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("should not set CORS headers for OPTIONS with disallowed origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "OPTIONS",
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      // Should still be 200 but without CORS headers
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("GET Request Tests", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "production",
      } as ReturnType<typeof env>);
    });

    it("should set CORS headers for GET request with allowed origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "GET",
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });

    it("should not return preflight headers for GET request", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "GET",
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      // GET requests should not include preflight-specific headers
      expect(response.headers.get("Access-Control-Allow-Methods")).toBeNull();
      expect(response.headers.get("Access-Control-Allow-Headers")).toBeNull();
      expect(response.headers.get("Access-Control-Max-Age")).toBeNull();
    });
  });

  describe("POST Request Tests", () => {
    beforeEach(() => {
      vi.mocked(env).mockReturnValue({
        VERCEL_ENV: "production",
      } as ReturnType<typeof env>);
    });

    it("should set CORS headers for POST request with allowed origin", () => {
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        method: "POST",
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe(
        "true",
      );
    });
  });
});
