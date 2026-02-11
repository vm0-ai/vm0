import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getPlatformUrl } from "../url";

describe("url", () => {
  describe("getPlatformUrl (SaaS mode)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("replaces www with platform in hostname", () => {
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

    it("returns Caddy URL when window is undefined in development", () => {
      vi.stubGlobal("window", undefined);
      vi.stubEnv("NODE_ENV", "development");

      expect(getPlatformUrl()).toBe("https://platform.vm7.ai:8443");
    });

    it("returns production URL when window is undefined in production", () => {
      vi.stubGlobal("window", undefined);
      vi.stubEnv("NODE_ENV", "production");

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

      expect(getPlatformUrl()).toBe("https://vm0.ai");
    });
  });

  describe("getPlatformUrl (self-hosted mode)", () => {
    beforeEach(() => {
      vi.stubEnv("SELF_HOSTED", "true");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("returns /platform on the client side", () => {
      Object.defineProperty(global, "window", {
        value: { location: { origin: "http://localhost:8080" } },
        writable: true,
        configurable: true,
      });

      expect(getPlatformUrl()).toBe("/platform");
    });

    it("returns PLATFORM_URL on the server side", () => {
      vi.stubGlobal("window", undefined);
      vi.stubEnv("PLATFORM_URL", "http://myhost:3001");

      expect(getPlatformUrl()).toBe("http://myhost:3001");
    });

    it("falls back to localhost with PLATFORM_PORT on the server side", () => {
      vi.stubGlobal("window", undefined);
      vi.stubEnv("PLATFORM_PORT", "5000");

      expect(getPlatformUrl()).toBe("http://localhost:5000");
    });

    it("falls back to localhost:3001 when no env vars set", () => {
      vi.stubGlobal("window", undefined);

      expect(getPlatformUrl()).toBe("http://localhost:3001");
    });
  });
});
