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

import { legalRedirectLayer, runLayers } from "../proxy.layers";

/**
 * Helper to run the legalRedirectLayer through the real runLayers pipeline.
 * This exercises the full middleware context creation including route classification.
 */
function runLegal(url: string) {
  const request = new NextRequest(url);
  return runLayers(request, [legalRedirectLayer]);
}

describe("legalRedirectLayer", () => {
  describe("redirects locale-prefixed legal pages to root paths", () => {
    it("redirects /en/terms-of-use to /terms-of-use with 308", async () => {
      const response = await runLegal("https://www.vm0.ai/en/terms-of-use");
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/terms-of-use",
      );
    });

    it("redirects /de/privacy-policy to /privacy-policy with 308", async () => {
      const response = await runLegal("https://www.vm0.ai/de/privacy-policy");
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/privacy-policy",
      );
    });

    it("redirects /ja/terms-of-use to /terms-of-use with 308", async () => {
      const response = await runLegal("https://www.vm0.ai/ja/terms-of-use");
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/terms-of-use",
      );
    });

    it("redirects /es/privacy-policy to /privacy-policy with 308", async () => {
      const response = await runLegal("https://www.vm0.ai/es/privacy-policy");
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/privacy-policy",
      );
    });

    it("redirects /en/support to /support with 308", async () => {
      const response = await runLegal("https://www.vm0.ai/en/support");
      expect(response.status).toBe(308);
      expect(new URL(response.headers.get("location")!).pathname).toBe(
        "/support",
      );
    });
  });

  describe("does not redirect root legal pages", () => {
    it("passes through /terms-of-use without redirect", async () => {
      const response = await runLegal("https://www.vm0.ai/terms-of-use");
      expect(response.status).toBe(200);
    });

    it("passes through /privacy-policy without redirect", async () => {
      const response = await runLegal("https://www.vm0.ai/privacy-policy");
      expect(response.status).toBe(200);
    });

    it("passes through /support without redirect", async () => {
      const response = await runLegal("https://www.vm0.ai/support");
      expect(response.status).toBe(200);
    });
  });

  describe("does not redirect non-legal locale pages", () => {
    it("passes through /en/pricing without redirect", async () => {
      const response = await runLegal("https://www.vm0.ai/en/pricing");
      expect(response.status).toBe(200);
    });
  });

  describe("does not redirect invalid locales", () => {
    it("passes through /xx/terms-of-use (unsupported locale) without redirect", async () => {
      const response = await runLegal("https://www.vm0.ai/xx/terms-of-use");
      expect(response.status).toBe(200);
    });
  });
});
