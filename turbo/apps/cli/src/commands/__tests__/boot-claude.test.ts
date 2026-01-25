import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  checkMarketplaceExists,
  checkPluginInstalled,
  getClaudePluginsDir,
} from "../boot-claude";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";

describe("boot-claude command", () => {
  let tempDir: string;
  let claudePluginsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-boot-claude-"));
    claudePluginsDir = path.join(tempDir, ".claude", "plugins");
    mkdirSync(claudePluginsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getClaudePluginsDir", () => {
    it("should return plugins dir under provided home", () => {
      const result = getClaudePluginsDir("/custom/home");
      expect(result).toBe("/custom/home/.claude/plugins");
    });

    it("should use os.homedir when no home provided", () => {
      const result = getClaudePluginsDir();
      expect(result).toBe(path.join(os.homedir(), ".claude", "plugins"));
    });
  });

  describe("checkMarketplaceExists", () => {
    it("should return false when known_marketplaces.json does not exist", () => {
      expect(checkMarketplaceExists(tempDir)).toBe(false);
    });

    it("should return false when marketplace is not in config", () => {
      const configPath = path.join(claudePluginsDir, "known_marketplaces.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          "other-marketplace": {
            source: { source: "git", url: "https://example.com/other.git" },
            installLocation: "/path/to/other",
            lastUpdated: "2024-01-01T00:00:00.000Z",
          },
        }),
      );

      expect(checkMarketplaceExists(tempDir)).toBe(false);
    });

    it("should return true when vm0-skills marketplace exists in config", () => {
      const configPath = path.join(claudePluginsDir, "known_marketplaces.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          "vm0-skills": {
            source: {
              source: "git",
              url: "https://github.com/vm0-ai/vm0-skills.git",
            },
            installLocation: "/path/to/vm0-skills",
            lastUpdated: "2024-01-01T00:00:00.000Z",
          },
        }),
      );

      expect(checkMarketplaceExists(tempDir)).toBe(true);
    });
  });

  describe("checkPluginInstalled", () => {
    it("should return false when installed_plugins.json does not exist", () => {
      expect(checkPluginInstalled(tempDir)).toBe(false);
    });

    it("should return false when plugin is not in config", () => {
      const configPath = path.join(claudePluginsDir, "installed_plugins.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 2,
          plugins: {
            "other-plugin@other-marketplace": [
              {
                scope: "global",
                installPath: "/path/to/other",
                version: "1.0.0",
              },
            ],
          },
        }),
      );

      expect(checkPluginInstalled(tempDir)).toBe(false);
    });

    it("should return true when vm0-cli plugin is installed", () => {
      const configPath = path.join(claudePluginsDir, "installed_plugins.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 2,
          plugins: {
            "vm0-cli@vm0-skills": [
              {
                scope: "global",
                installPath: "/path/to/vm0-cli",
                version: "1.0.0",
              },
            ],
          },
        }),
      );

      expect(checkPluginInstalled(tempDir)).toBe(true);
    });

    it("should return true when plugin exists among other plugins", () => {
      const configPath = path.join(claudePluginsDir, "installed_plugins.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          version: 2,
          plugins: {
            "other-plugin@other-marketplace": [
              {
                scope: "global",
                installPath: "/path/to/other",
                version: "1.0.0",
              },
            ],
            "vm0-cli@vm0-skills": [
              {
                scope: "project",
                installPath: "/path/to/vm0-cli",
                version: "2.0.0",
              },
            ],
          },
        }),
      );

      expect(checkPluginInstalled(tempDir)).toBe(true);
    });
  });
});
