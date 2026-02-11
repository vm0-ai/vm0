import { describe, it, expect, vi } from "vitest";
import { reloadEnv } from "../../../../src/env";
import { getBlogBaseUrl } from "../config";

describe("blog/config", () => {
  describe("getBlogBaseUrl", () => {
    it("returns the configured base URL", () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_URL", "https://vm0.ai");
      reloadEnv();

      expect(getBlogBaseUrl()).toBe("https://vm0.ai");
    });

    it("throws when NEXT_PUBLIC_BASE_URL is not configured", () => {
      // setup.ts doesn't stub NEXT_PUBLIC_BASE_URL, so env() has it as undefined
      expect(() => getBlogBaseUrl()).toThrow(
        "NEXT_PUBLIC_BASE_URL environment variable is not configured",
      );
    });
  });
});
