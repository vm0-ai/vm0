import { describe, it, expect, afterEach } from "vitest";
import {
  getProviderDefaults,
  isProviderSupported,
  getSupportedProviders,
  getDefaultImage,
} from "../provider-config";

describe("provider-config", () => {
  describe("getProviderDefaults", () => {
    it("returns defaults for claude-code provider", () => {
      const defaults = getProviderDefaults("claude-code");
      expect(defaults).toBeDefined();
      expect(defaults?.workingDir).toBe("/home/user/workspace");
      expect(defaults?.image.production).toBe("vm0/claude-code:latest");
      expect(defaults?.image.development).toBe("vm0/claude-code:dev");
    });

    it("returns defaults for codex provider", () => {
      const defaults = getProviderDefaults("codex");
      expect(defaults).toBeDefined();
      expect(defaults?.workingDir).toBe("/home/user/workspace");
      expect(defaults?.image.production).toBe("vm0/codex:latest");
      expect(defaults?.image.development).toBe("vm0/codex:dev");
    });

    it("returns undefined for unknown provider", () => {
      const defaults = getProviderDefaults("unknown");
      expect(defaults).toBeUndefined();
    });
  });

  describe("isProviderSupported", () => {
    it("returns true for claude-code", () => {
      expect(isProviderSupported("claude-code")).toBe(true);
    });

    it("returns true for codex", () => {
      expect(isProviderSupported("codex")).toBe(true);
    });

    it("returns false for unknown provider", () => {
      expect(isProviderSupported("unknown")).toBe(false);
    });
  });

  describe("getSupportedProviders", () => {
    it("returns array containing claude-code and codex", () => {
      const providers = getSupportedProviders();
      expect(providers).toContain("claude-code");
      expect(providers).toContain("codex");
    });
  });

  describe("getDefaultImage", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    describe("claude-code provider", () => {
      it("returns production image when NODE_ENV is production", () => {
        process.env.NODE_ENV = "production";
        expect(getDefaultImage("claude-code")).toBe("vm0/claude-code:latest");
      });

      it("returns dev image when NODE_ENV is development", () => {
        process.env.NODE_ENV = "development";
        expect(getDefaultImage("claude-code")).toBe("vm0/claude-code:dev");
      });

      it("returns dev image when NODE_ENV is test", () => {
        process.env.NODE_ENV = "test";
        expect(getDefaultImage("claude-code")).toBe("vm0/claude-code:dev");
      });
    });

    describe("codex provider", () => {
      it("returns production image when NODE_ENV is production", () => {
        process.env.NODE_ENV = "production";
        expect(getDefaultImage("codex")).toBe("vm0/codex:latest");
      });

      it("returns dev image when NODE_ENV is development", () => {
        process.env.NODE_ENV = "development";
        expect(getDefaultImage("codex")).toBe("vm0/codex:dev");
      });

      it("returns dev image when NODE_ENV is test", () => {
        process.env.NODE_ENV = "test";
        expect(getDefaultImage("codex")).toBe("vm0/codex:dev");
      });
    });

    it("returns undefined for unknown provider", () => {
      expect(getDefaultImage("unknown")).toBeUndefined();
    });

    describe("default behavior (NODE_ENV undefined or unrecognized)", () => {
      it("returns production image for claude-code when NODE_ENV is undefined", () => {
        delete process.env.NODE_ENV;
        expect(getDefaultImage("claude-code")).toBe("vm0/claude-code:latest");
      });

      it("returns production image for codex when NODE_ENV is undefined", () => {
        delete process.env.NODE_ENV;
        expect(getDefaultImage("codex")).toBe("vm0/codex:latest");
      });

      it("returns production image for claude-code when NODE_ENV is unrecognized", () => {
        process.env.NODE_ENV = "staging";
        expect(getDefaultImage("claude-code")).toBe("vm0/claude-code:latest");
      });
    });
  });
});
