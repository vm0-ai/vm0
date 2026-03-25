import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import { zeroWhoamiCommand } from "../whoami";

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-zero-whoami-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => TEST_HOME,
  };
});

/**
 * Build a valid ZERO_TOKEN for testing.
 * Format: vm0_sandbox_<header>.<payload>.<signature>
 */
function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = "test-signature";
  return `vm0_sandbox_${header}.${body}.${signature}`;
}

describe("zero whoami command", () => {
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
    await zeroWhoamiCommand.parseAsync(["node", "cli"]);
  }

  describe("sandbox mode (ZERO_AGENT_ID set)", () => {
    it("should show agent ID, run context, and capabilities with full JWT", async () => {
      const token = buildZeroToken({
        userId: "user-1",
        runId: "run-abc",
        orgId: "org-xyz",
        scope: "zero",
        capabilities: ["agent:read", "agent:write", "schedule:read"],
        iat: 1000,
        exp: 2000,
      });
      vi.stubEnv("ZERO_AGENT_ID", "agent-123");
      vi.stubEnv("ZERO_TOKEN", token);

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Agent ID:"))).toBe(true);
      expect(output.some((line) => line.includes("agent-123"))).toBe(true);
      expect(output.some((line) => line.includes("Run ID:"))).toBe(true);
      expect(output.some((line) => line.includes("run-abc"))).toBe(true);
      expect(output.some((line) => line.includes("Org ID:"))).toBe(true);
      expect(output.some((line) => line.includes("org-xyz"))).toBe(true);
      expect(output.some((line) => line.includes("Capabilities:"))).toBe(true);
      expect(output.some((line) => line.includes("agent:read"))).toBe(true);
      expect(output.some((line) => line.includes("schedule:read"))).toBe(true);
    });

    it("should show unavailable when ZERO_TOKEN is missing", async () => {
      vi.stubEnv("ZERO_AGENT_ID", "agent-no-token");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Agent ID:"))).toBe(true);
      expect(output.some((line) => line.includes("agent-no-token"))).toBe(true);
      expect(output.some((line) => line.includes("Run ID:"))).toBe(true);
      expect(output.some((line) => line.includes("unavailable"))).toBe(true);
      expect(output.some((line) => line.includes("Capabilities:"))).toBe(false);
    });

    it("should show unavailable when ZERO_TOKEN is malformed", async () => {
      vi.stubEnv("ZERO_AGENT_ID", "agent-bad-token");
      vi.stubEnv("ZERO_TOKEN", "not-a-valid-token");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("agent-bad-token"))).toBe(
        true,
      );
      expect(output.some((line) => line.includes("unavailable"))).toBe(true);
    });
  });

  describe("local mode (no ZERO_AGENT_ID)", () => {
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

    it("should show authenticated via ZERO_TOKEN env var", async () => {
      vi.stubEnv("ZERO_TOKEN", "env-token-test");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Authenticated"))).toBe(true);
      expect(output.some((line) => line.includes("ZERO_TOKEN env var"))).toBe(
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

    it("should display active org when set", async () => {
      vi.stubEnv("VM0_ACTIVE_ORG", "test-org-slug");

      await runWhoami();

      const output = getAllOutput();
      expect(output.some((line) => line.includes("Org:"))).toBe(true);
      expect(output.some((line) => line.includes("test-org-slug"))).toBe(true);
    });
  });
});
