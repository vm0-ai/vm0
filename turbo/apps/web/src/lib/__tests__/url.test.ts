import { describe, it, expect, vi, afterEach } from "vitest";
import { getPlatformUrl } from "../url";

describe("url", () => {
  describe("getPlatformUrl", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("replaces www with platform in hostname", () => {
      // Mock window.location
      Object.defineProperty(global, "window", {
        value: {
          location: {
            origin: "https://www.vm0.ai",
          },
        },
        writable: true,
        configurable: true,
      });

      expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
    });

    it("preserves port when replacing www with platform", () => {
      Object.defineProperty(global, "window", {
        value: {
          location: {
            origin: "https://www.vm7.ai:8443",
          },
        },
        writable: true,
        configurable: true,
      });

      expect(getPlatformUrl()).toBe("https://platform.vm7.ai:8443");
    });

    it("preserves http protocol", () => {
      Object.defineProperty(global, "window", {
        value: {
          location: {
            origin: "http://www.localhost:3000",
          },
        },
        writable: true,
        configurable: true,
      });

      expect(getPlatformUrl()).toBe("http://platform.localhost:3000");
    });

    it("returns fallback URL when window is undefined (SSR)", () => {
      vi.stubGlobal("window", undefined);

      expect(getPlatformUrl()).toBe("https://platform.vm0.ai");
    });

    it("handles hostname without www prefix", () => {
      Object.defineProperty(global, "window", {
        value: {
          location: {
            origin: "https://vm0.ai",
          },
        },
        writable: true,
        configurable: true,
      });

      // When there's no www, the hostname remains unchanged
      expect(getPlatformUrl()).toBe("https://vm0.ai");
    });
  });
});
