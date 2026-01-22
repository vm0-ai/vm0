import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeForShell,
  buildRerunCommand,
  getLatestVersion,
  checkAndUpgrade,
  detectPackageManager,
} from "../update-checker";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";

describe("update-checker", () => {
  describe("detectPackageManager", () => {
    const originalArgv = process.argv;

    afterEach(() => {
      process.argv = originalArgv;
    });

    it("should return 'pnpm' when path contains pnpm", () => {
      process.argv = [
        "/usr/bin/node",
        "/home/user/.local/share/pnpm/global/5/node_modules/.bin/vm0",
      ];
      expect(detectPackageManager()).toBe("pnpm");
    });

    it("should return 'npm' when path does not contain pnpm", () => {
      process.argv = [
        "/usr/bin/node",
        "/Users/user/.nvm/versions/node/v20.0.0/bin/vm0",
      ];
      expect(detectPackageManager()).toBe("npm");
    });

    it("should return 'npm' for standard npm global path", () => {
      process.argv = ["/usr/bin/node", "/usr/local/bin/vm0"];
      expect(detectPackageManager()).toBe("npm");
    });

    it("should return 'npm' for fnm path", () => {
      process.argv = [
        "/usr/bin/node",
        "/home/user/.fnm/node-versions/v20.0.0/installation/bin/vm0",
      ];
      expect(detectPackageManager()).toBe("npm");
    });

    it("should return 'npm' for volta path", () => {
      process.argv = ["/usr/bin/node", "/home/user/.volta/bin/vm0"];
      expect(detectPackageManager()).toBe("npm");
    });

    it("should return 'unknown' when argv[1] is undefined", () => {
      process.argv = ["/usr/bin/node"];
      expect(detectPackageManager()).toBe("unknown");
    });

    it("should return 'unknown' for unrecognized path", () => {
      process.argv = ["/usr/bin/node", "/some/random/path/vm0"];
      expect(detectPackageManager()).toBe("unknown");
    });

    it("should return 'bun' when path contains /.bun/", () => {
      process.argv = ["/usr/bin/node", "/home/user/.bun/bin/vm0"];
      expect(detectPackageManager()).toBe("bun");
    });

    it("should return 'bun' when path contains /bun/", () => {
      process.argv = ["/usr/bin/node", "/opt/bun/bin/vm0"];
      expect(detectPackageManager()).toBe("bun");
    });

    it("should return 'yarn' when path contains /.yarn/", () => {
      process.argv = ["/usr/bin/node", "/home/user/.yarn/bin/vm0"];
      expect(detectPackageManager()).toBe("yarn");
    });

    it("should return 'yarn' when path contains /yarn/", () => {
      process.argv = ["/usr/bin/node", "/opt/yarn/bin/vm0"];
      expect(detectPackageManager()).toBe("yarn");
    });
  });

  describe("escapeForShell", () => {
    it("should wrap string in double quotes", () => {
      expect(escapeForShell("hello world")).toBe('"hello world"');
    });

    it("should escape internal double quotes", () => {
      expect(escapeForShell('say "hello"')).toBe('"say \\"hello\\""');
    });

    it("should handle empty string", () => {
      expect(escapeForShell("")).toBe('""');
    });

    it("should handle string with multiple double quotes", () => {
      expect(escapeForShell('"a" and "b"')).toBe('"\\"a\\" and \\"b\\""');
    });

    it("should handle string with single quotes (no escaping needed)", () => {
      expect(escapeForShell("it's fine")).toBe('"it\'s fine"');
    });

    it("should handle string with special characters", () => {
      expect(escapeForShell("hello $world")).toBe('"hello $world"');
    });
  });

  describe("buildRerunCommand", () => {
    it("should build command with prompt", () => {
      expect(buildRerunCommand("hello world")).toBe('vm0 cook "hello world"');
    });

    it("should build command without prompt", () => {
      expect(buildRerunCommand(undefined)).toBe("vm0 cook");
    });

    it("should escape double quotes in prompt", () => {
      expect(buildRerunCommand('say "hi"')).toBe('vm0 cook "say \\"hi\\""');
    });

    it("should handle empty string prompt (treated as no prompt)", () => {
      // Empty string is falsy, so treated as no prompt
      expect(buildRerunCommand("")).toBe("vm0 cook");
    });
  });

  describe("getLatestVersion", () => {
    it("should return version from npm registry response", async () => {
      const version = await getLatestVersion();
      expect(version).toBe("4.11.0");
    });

    it("should return null on invalid JSON response", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.text("not valid json");
        }),
      );

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null when response has no version field", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ name: "@vm0/cli" });
        }),
      );

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null on network error", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.error();
        }),
      );

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });
  });

  describe("checkAndUpgrade", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should return false and warn when version check fails", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.error();
        }),
      );

      const result = await checkAndUpgrade("4.10.0", "test prompt");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Could not check for updates"),
      );
    });

    it("should return false when already on latest version", async () => {
      server.use(
        http.get("https://registry.npmjs.org/*/latest", () => {
          return HttpResponse.json({ version: "4.10.0" });
        }),
      );

      const result = await checkAndUpgrade("4.10.0", "test prompt");

      expect(result).toBe(false);
      // Should not log EA notice
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Early Access"),
      );
    });

    describe("unsupported package managers", () => {
      const originalArgv = process.argv;

      afterEach(() => {
        process.argv = originalArgv;
      });

      it("should return false and show manual instructions for bun", async () => {
        process.argv = ["/usr/bin/node", "/home/user/.bun/bin/vm0"];
        server.use(
          http.get("https://registry.npmjs.org/*/latest", () => {
            return HttpResponse.json({ version: "5.0.0" });
          }),
        );

        const result = await checkAndUpgrade("4.10.0", "test prompt");

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Auto-upgrade is not supported for bun"),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("bun add -g @vm0/cli@latest"),
        );
      });

      it("should return false and show manual instructions for yarn", async () => {
        process.argv = ["/usr/bin/node", "/home/user/.yarn/bin/vm0"];
        server.use(
          http.get("https://registry.npmjs.org/*/latest", () => {
            return HttpResponse.json({ version: "5.0.0" });
          }),
        );

        const result = await checkAndUpgrade("4.10.0", "test prompt");

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("Auto-upgrade is not supported for yarn"),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("yarn global add @vm0/cli@latest"),
        );
      });

      it("should return false and show manual instructions for unknown package manager", async () => {
        process.argv = ["/usr/bin/node", "/some/random/path/vm0"];
        server.use(
          http.get("https://registry.npmjs.org/*/latest", () => {
            return HttpResponse.json({ version: "5.0.0" });
          }),
        );

        const result = await checkAndUpgrade("4.10.0", "test prompt");

        expect(result).toBe(false);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "Could not detect your package manager for auto-upgrade",
          ),
        );
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("npm install -g @vm0/cli@latest"),
        );
      });
    });
  });
});
