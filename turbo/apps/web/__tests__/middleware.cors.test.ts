import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import type { handleCors as HandleCorsType } from "../middleware.cors";

describe("handleCors", () => {
  const originalVercelEnv = process.env.VERCEL_ENV;

  // Helper to get handleCors with fresh env
  async function getHandleCors(
    vercelEnv: "production" | "preview" | "development" | undefined,
  ): Promise<typeof HandleCorsType> {
    if (vercelEnv !== undefined) {
      process.env.VERCEL_ENV = vercelEnv;
    } else {
      delete process.env.VERCEL_ENV;
    }
    const { handleCors } = await import("../middleware.cors");
    return handleCors;
  }

  afterEach(() => {
    // Restore original VERCEL_ENV
    if (originalVercelEnv !== undefined) {
      process.env.VERCEL_ENV = originalVercelEnv;
    } else {
      delete process.env.VERCEL_ENV;
    }
    // Clear module cache to allow fresh env() initialization
    vi.resetModules();
  });

  describe("Production Environment (VERCEL_ENV=production)", () => {
    it("should accept exact match: https://www.vm0.ai", async () => {
      const handleCors = await getHandleCors("production");
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

    it("should accept exact match: https://vm0.ai", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0.ai",
      );
    });

    it("should accept *.vm0.ai subdomain: https://platform.vm0.ai", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });

    it("should accept any *.vm0.ai subdomain", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://any-subdomain.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-subdomain.vm0.ai",
      );
    });

    it("should reject *.vercel.app origin", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://example-app.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject localhost origin", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject invalid origin", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("Preview Environment (VERCEL_ENV=preview)", () => {
    it("should accept production domain: https://www.vm0.ai", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm0.ai",
      );
    });

    it("should accept *.vm0.ai subdomain: https://platform.vm0.ai", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });

    it("should accept *.vercel.app origin: https://vm0-platform-abc123.vercel.app", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0-platform-abc123.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0-platform-abc123.vercel.app",
      );
    });

    it("should accept any *.vercel.app subdomain", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://any-app-xyz.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://any-app-xyz.vercel.app",
      );
    });

    it("should reject localhost origin", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject invalid origin", async () => {
      const handleCors = await getHandleCors("preview");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });
  });

  describe("Development Environment (VERCEL_ENV=development)", () => {
    it("should accept production domain: https://www.vm0.ai", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm0.ai",
      );
    });

    it("should accept localhost:3000", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("should accept localhost:5173", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:5173" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:5173",
      );
    });

    it("should accept localhost with any port", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:8080" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:8080",
      );
    });

    it("should accept *.vercel.app origin", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://vm0-platform-abc.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://vm0-platform-abc.vercel.app",
      );
    });

    it("should reject invalid origin", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://malicious.com" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should accept *.vm7.ai local dev domain: https://platform.vm7.ai:8443", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm7.ai:8443" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm7.ai:8443",
      );
    });

    it("should accept *.vm7.ai with any port", async () => {
      const handleCors = await getHandleCors("development");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://www.vm7.ai:32796" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://www.vm7.ai:32796",
      );
    });
  });

  describe("Undefined Environment (VERCEL_ENV=undefined, treats as development)", () => {
    it("should accept localhost origin", async () => {
      const handleCors = await getHandleCors(undefined);
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://localhost:3000" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://localhost:3000",
      );
    });

    it("should accept *.vercel.app origin", async () => {
      const handleCors = await getHandleCors(undefined);
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://test-app.vercel.app" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://test-app.vercel.app",
      );
    });

    it("should accept *.vm0.ai subdomain", async () => {
      const handleCors = await getHandleCors(undefined);
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai",
      );
    });

    it("should accept *.vm7.ai local dev domain", async () => {
      const handleCors = await getHandleCors(undefined);
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm7.ai:8443" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm7.ai:8443",
      );
    });
  });

  describe("Edge Cases", () => {
    it("should reject null origin", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs");

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should reject undefined origin", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: {},
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should handle malformed origin URL gracefully", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "not-a-valid-url" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("should handle origin with unusual port", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "https://platform.vm0.ai:8443" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "https://platform.vm0.ai:8443",
      );
    });

    it("should handle HTTP vs HTTPS correctly", async () => {
      const handleCors = await getHandleCors("production");
      const request = new NextRequest("https://api.vm0.ai/v1/runs", {
        headers: { origin: "http://platform.vm0.ai" },
      });

      const response = handleCors(request);

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        "http://platform.vm0.ai",
      );
    });

    it("should handle case sensitivity in hostname (lowercase vercel.app)", async () => {
      const handleCors = await getHandleCors("production");
      process.env.VERCEL_ENV = "preview";

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
    it("should handle OPTIONS request with correct headers", async () => {
      const handleCors = await getHandleCors("production");
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

    it("should handle OPTIONS request in preview environment", async () => {
      const handleCors = await getHandleCors("production");
      process.env.VERCEL_ENV = "preview";

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

    it("should handle OPTIONS request in development environment", async () => {
      const handleCors = await getHandleCors("production");
      process.env.VERCEL_ENV = "development";

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

    it("should not set CORS headers for OPTIONS with disallowed origin", async () => {
      const handleCors = await getHandleCors("production");
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
    it("should set CORS headers for GET request with allowed origin", async () => {
      const handleCors = await getHandleCors("production");
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

    it("should not return preflight headers for GET request", async () => {
      const handleCors = await getHandleCors("production");
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
    it("should set CORS headers for POST request with allowed origin", async () => {
      const handleCors = await getHandleCors("production");
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
