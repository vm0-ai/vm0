import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Mock next-intl/middleware to avoid ESM resolution issues in test environment.
// This is an external dependency mock (not internal code), which is acceptable.
vi.mock("next-intl/middleware", () => {
  return {
    default: () => {
      return () => {
        return NextResponse.next();
      };
    },
  };
});

import { classifyRoute, localeGuardLayer, runLayers } from "../proxy.layers";

/**
 * Helper to run the localeGuardLayer through the real runLayers pipeline.
 * This exercises the full middleware context creation including route classification.
 */
function runGuard(url: string) {
  const request = new NextRequest(url);
  return runLayers(request, [localeGuardLayer]);
}

describe("localeGuardLayer", () => {
  describe("rejects invalid locale segments containing a dot", () => {
    it("should return 404 for /favicon.ico/blog", async () => {
      const response = await runGuard("https://www.vm0.ai/favicon.ico/blog");
      expect(response.status).toBe(404);
    });

    it("should return 404 for /robots.txt/page", async () => {
      const response = await runGuard("https://www.vm0.ai/robots.txt/page");
      expect(response.status).toBe(404);
    });

    it("should return 404 for /sitemap.xml/something", async () => {
      const response = await runGuard(
        "https://www.vm0.ai/sitemap.xml/something",
      );
      expect(response.status).toBe(404);
    });
  });

  describe("allows valid locale segments", () => {
    it("should pass through for /en/blog", async () => {
      const response = await runGuard("https://www.vm0.ai/en/blog");
      expect(response.status).toBe(200);
    });

    it("should pass through for /de/blog", async () => {
      const response = await runGuard("https://www.vm0.ai/de/blog");
      expect(response.status).toBe(200);
    });

    it("should pass through for /ja/pricing", async () => {
      const response = await runGuard("https://www.vm0.ai/ja/pricing");
      expect(response.status).toBe(200);
    });

    it("should pass through for /es/about", async () => {
      const response = await runGuard("https://www.vm0.ai/es/about");
      expect(response.status).toBe(200);
    });
  });

  describe("does not affect non-page routes", () => {
    it("should pass through for API routes", async () => {
      const response = await runGuard(
        "https://www.vm0.ai/api/something.ext/path",
      );
      expect(response.status).toBe(200);
    });

    it("should pass through for static file routes", async () => {
      const response = await runGuard("https://www.vm0.ai/_next/static/chunk");
      expect(response.status).toBe(200);
    });

    it("should keep desktop auth outside locale processing", () => {
      expect(classifyRoute("/desktop-auth/start")).toBe("skip");
      expect(classifyRoute("/desktop-auth/consume")).toBe("skip");
      expect(classifyRoute("/desktop-auth/callback")).toBe("skip");
      expect(classifyRoute("/desktop-auth/select-org")).toBe("skip");
      expect(classifyRoute("/desktop-auth/token")).toBe("skip");
    });
  });

  describe("edge cases", () => {
    it("should pass through for root path", async () => {
      const response = await runGuard("https://www.vm0.ai/");
      expect(response.status).toBe(200);
    });

    it("should pass through for segments without dots", async () => {
      const response = await runGuard("https://www.vm0.ai/unknown/page");
      expect(response.status).toBe(200);
    });

    it("should not return JSON content-type for 404", async () => {
      const response = await runGuard("https://www.vm0.ai/favicon.ico/blog");
      const contentType = response.headers.get("Content-Type");
      expect(
        contentType === null || !contentType.includes("application/json"),
      ).toBe(true);
    });
  });
});
