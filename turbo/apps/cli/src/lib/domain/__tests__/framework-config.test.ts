import { describe, it, expect, afterEach } from "vitest";
import {
  getFrameworkDefaults,
  isFrameworkSupported,
  getSupportedFrameworks,
  getDefaultImage,
} from "../framework-config";

describe("framework-config", () => {
  describe("getFrameworkDefaults", () => {
    it("returns defaults for claude-code framework", () => {
      const defaults = getFrameworkDefaults("claude-code");
      expect(defaults).toBeDefined();
      expect(defaults?.workingDir).toBe("/home/user/workspace");
      expect(defaults?.image.production).toBe("vm0/claude-code:latest");
      expect(defaults?.image.development).toBe("vm0/claude-code:dev");
    });

    it("returns defaults for codex framework", () => {
      const defaults = getFrameworkDefaults("codex");
      expect(defaults).toBeDefined();
      expect(defaults?.workingDir).toBe("/home/user/workspace");
      expect(defaults?.image.production).toBe("vm0/codex:latest");
      expect(defaults?.image.development).toBe("vm0/codex:dev");
    });

    it("returns undefined for unknown framework", () => {
      const defaults = getFrameworkDefaults("unknown");
      expect(defaults).toBeUndefined();
    });
  });

  describe("isFrameworkSupported", () => {
    it("returns true for claude-code", () => {
      expect(isFrameworkSupported("claude-code")).toBe(true);
    });

    it("returns true for codex", () => {
      expect(isFrameworkSupported("codex")).toBe(true);
    });

    it("returns false for unknown framework", () => {
      expect(isFrameworkSupported("unknown")).toBe(false);
    });
  });

  describe("getSupportedFrameworks", () => {
    it("returns array containing claude-code and codex", () => {
      const frameworks = getSupportedFrameworks();
      expect(frameworks).toContain("claude-code");
      expect(frameworks).toContain("codex");
    });
  });

  describe("getDefaultImage", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    describe("claude-code framework", () => {
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

    describe("codex framework", () => {
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

    it("returns undefined for unknown framework", () => {
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
