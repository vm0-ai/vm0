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

function buildFakeCliJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `vm0_pat_${header}.${body}.${sig}`;
}

function buildFakeZeroJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `vm0_sandbox_${header}.${body}.${sig}`;
}

// Mock os.homedir to use temp directory for config isolation
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), "test-whoami-home-"));
vi.mock("os", async (importOriginal) => {
  const original = await importOriginal<typeof import("os")>();
  return {
    ...original,
    homedir: () => {
      return TEST_HOME;
    },
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
      .map((call) => {
        return call[0] as string | undefined;
      })
      .filter((call): call is string => {
        return call !== undefined;
      });
  }

  async function runWhoami(): Promise<void> {
    await whoamiCommand.parseAsync(["node", "cli"]);
  }

  describe("sandbox mode (VM0_RUN_ID set)", () => {
    it("should show full agent info when all agent env vars are present", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-123");
      vi.stubEnv("ZERO_AGENT_ID", "agent-456");
      vi.stubEnv("CLI_AGENT_TYPE", "claude");
      vi.stubEnv(
        "ZERO_TOKEN",
        buildFakeZeroJwt({
          scope: "zero",
          orgId: "active-org",
          capabilities: [],
        }),
      );
      const apiUrl = "https://api.vm0.ai";
      vi.stubEnv("VM0_API_URL", apiUrl);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("agent-456");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("claude");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Run:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-123");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("active-org");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes(apiUrl);
        }),
      ).toBe(true);
    });

    it("should skip agent section when no agent env vars are set", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-789");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent:");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("Run:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("run-789");
        }),
      ).toBe(true);
    });

    it("should show agent section with only partial info when only ZERO_AGENT_ID is set", async () => {
      vi.stubEnv("VM0_RUN_ID", "run-partial");
      vi.stubEnv("ZERO_AGENT_ID", "partial-agent-id");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Agent:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("partial-agent-id");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("Framework:");
        }),
      ).toBe(false);
      expect(
        output.some((line) => {
          return line.includes("Run:");
        }),
      ).toBe(true);
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
      expect(
        output.some((line) => {
          return line.includes("Authenticated");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("config file");
        }),
      ).toBe(true);
    });

    it("should show authenticated via env var when VM0_TOKEN is set", async () => {
      vi.stubEnv("VM0_TOKEN", "env-token-test");

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Authenticated");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("VM0_TOKEN env var");
        }),
      ).toBe(true);
    });

    it("should show not authenticated when no token exists", async () => {
      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Not authenticated");
        }),
      ).toBe(true);
    });

    it("should display active org from CLI JWT token", async () => {
      const cliJwt = buildFakeCliJwt({
        scope: "cli",
        orgId: "test-org-slug",
        userId: "user-1",
        tokenId: "tok-1",
      });
      vi.stubEnv("VM0_TOKEN", cliJwt);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes("Org:");
        }),
      ).toBe(true);
      expect(
        output.some((line) => {
          return line.includes("test-org-slug");
        }),
      ).toBe(true);
    });

    it("should display API URL", async () => {
      const customApiUrl = "https://custom-api.vm0.ai";
      vi.stubEnv("VM0_API_URL", customApiUrl);

      await runWhoami();

      const output = getAllOutput();
      expect(
        output.some((line) => {
          return line.includes(customApiUrl);
        }),
      ).toBe(true);
    });
  });
});
