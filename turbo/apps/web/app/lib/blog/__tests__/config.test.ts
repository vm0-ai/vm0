import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("blog/config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("BLOG_BASE_URL", () => {
    it("returns the configured base URL", async () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://vm0.ai");

      const { BLOG_BASE_URL } = await import("../config");

      expect(BLOG_BASE_URL).toBe("https://vm0.ai");
    });

    it("throws when NEXT_PUBLIC_BASE_URL is not configured", async () => {
      // Don't stub the env var - leave it undefined

      await expect(import("../config")).rejects.toThrow(
        "NEXT_PUBLIC_BASE_URL environment variable is not configured",
      );
    });
  });
});
