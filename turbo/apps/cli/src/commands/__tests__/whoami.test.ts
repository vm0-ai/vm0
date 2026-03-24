/**
 * Tests for whoami command
 *
 * Covers:
 * - Sandbox mode: agent info display, run info display, partial info
 * - Local mode: authentication via config file, env var, and unauthenticated state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import { whoamiCommand } from "../whoami";

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-whoami-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

describe("whoami command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    chalk.level = 0;

    // Ensure clean config state
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();

    // Clean up config
    const configDir = path.join(TEST_HOME, ".vm0");
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function getAllOutput(): string[] {
    return mockConsoleLog.mock.calls
      .map((call) => call[0] as string | undefined)
      .filter((call): call is string => call !== undefined);
  }

  async function runWhoami(): Promise<void> {
    await whoamiCommand.parseAsync(["node", "cli"]);
  }

  describe("sandbox mode (VM0_RUN_ID set)", () => {
    it("should show full agent info when all agent env vars are present", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-123");
      vi.stubEnv("VM0_AGENT_NAME", "my-agent");
      vi.stubEnv("VM0_AGENT_VERSION", "1.2.3");
      vi.stubEnv("VM0_AGENT_COMPOSE_ID", "compose-456");
      vi.stubEnv("VM0_AGENT_ORG_SLUG", "my-org");
      vi.stubEnv("CLI_AGENT_TYPE", "claude");
      vi.stubEnv("VM0_ACTIVE_ORG", "active-org");
      vi.stubEnv("VM0_API_URL", "https://api.vm0.ai");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Agent:"))).toBe(true);
      expect(output.some((line) => line.includes("my-agent"))).toBe(true);
      expect(output.some((line) => line.includes("1.2.3"))).toBe(true);
      expect(output.some((line) => line.includes("compose-456"))).toBe(true);
      expect(output.some((line) => line.includes("my-org"))).toBe(true);
      expect(output.some((line) => line.includes("claude"))).toBe(true);
      expect(output.some((line) => line.includes("Run:"))).toBe(true);
      expect(output.some((line) => line.includes("run-123"))).toBe(true);
      expect(output.some((line) => line.includes("active-org"))).toBe(true);
      expect(output.some((line) => line.includes("https://api.vm0.ai"))).toBe(
        true,
      );
    });

    it("should skip agent section when no agent env vars are set", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-789");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Agent:"))).toBe(false);
      expect(output.some((line) => line.includes("Run:"))).toBe(true);
      expect(output.some((line) => line.includes("run-789"))).toBe(true);
    });

    it("should show agent section with only partial info when only VM0_AGENT_NAME is set", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-partial");
      vi.stubEnv("VM0_AGENT_NAME", "partial-agent");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Agent:"))).toBe(true);
      expect(output.some((line) => line.includes("partial-agent"))).toBe(true);
      expect(output.some((line) => line.includes("Version:"))).toBe(false);
      expect(output.some((line) => line.includes("Compose ID:"))).toBe(false);
      expect(output.some((line) => line.includes("Run:"))).toBe(true);
    });
  });

  describe("local mode (no VM0_RUN_ID)", () => {
    it("should show authenticated via config file when token exists in config", async () => {
      const configDir = path.join(TEST_HOME, ".vm0");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ token: "test-token-config" }),
      );

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Authenticated"))).toBe(true);
      expect(output.some((line) => line.includes("config file"))).toBe(true);
    });

    it("should show authenticated via env var when VM0_TOKEN is set", async () => {
      vi.stubEnv("VM0_TOKEN", "env-token-test");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Authenticated"))).toBe(true);
      expect(output.some((line) => line.includes("VM0_TOKEN env var"))).toBe(
        true,
      );
    });

    it("should show not authenticated when no token exists", async () => {
      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Not authenticated"))).toBe(
        true,
      );
    });

    it("should display active org when VM0_ACTIVE_ORG is set", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "test-org-slug");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Org:"))).toBe(true);
      expect(output.some((line) => line.includes("test-org-slug"))).toBe(true);
    });

    it("should display API URL", async () => {
      vi.stubEnv("VM0_API_URL", "https://custom-api.vm0.ai");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => line.includes("https://custom-api.vm0.ai")),
      ).toBe(true);
    });
  });
});
