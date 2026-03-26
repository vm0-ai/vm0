import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { createMockChildProcess } from "../../../mocks/spawn-helpers";
import { composeCommand } from "../index";
import * as fs from "fs/promises";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

// Configurable handler called when execFile encounters a "git checkout" command.
let onGitCheckout: ((cwd: string) => void) | undefined;

// Mock child_process — the true external boundary for both spawn and execFile.
// spawn is used by silentUpgradeAfterCommand; execFile is used by git-client for git operations.
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
    execFile: vi.fn(
      (
        file: string,
        args: string[],
        optionsOrCallback: unknown,
        maybeCallback?: unknown,
      ): { pid: number } => {
        const callback =
          typeof optionsOrCallback === "function"
            ? (optionsOrCallback as (
                err: Error | null,
                result: { stdout: string; stderr: string },
              ) => void)
            : (maybeCallback as (
                err: Error | null,
                result: { stdout: string; stderr: string },
              ) => void);
        const options =
          typeof optionsOrCallback === "object"
            ? (optionsOrCallback as { cwd?: string })
            : undefined;
        const cwd = options?.cwd;
        const cmd = [file, ...args].join(" ");

        // git init: create .git/info/ so sparse-checkout file writes succeed
        if (cmd.startsWith("git init") && cwd) {
          mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
        }

        // git checkout: populate the working directory via test-provided handler
        if (cmd.startsWith("git checkout") && cwd && onGitCheckout) {
          onGitCheckout(cwd);
        }

        // git ls-remote: return a fake default branch reference
        if (cmd.includes("git ls-remote")) {
          callback(null, {
            stdout: "ref: refs/heads/main\tHEAD\n",
            stderr: "",
          });
          return { pid: 0 };
        }

        callback(null, { stdout: "", stderr: "" });
        return { pid: 0 };
      },
    ),
  };
});

import { spawn } from "child_process";
const mockSpawn = vi.mocked(spawn);

function createMockSkillDir(destDir: string, skillName: string): string {
  const skillDir = path.join(destDir, skillName);
  mkdirSync(skillDir, { recursive: true });

  const skillMd = `---
name: ${skillName}
---

# ${skillName}

Mock skill for testing.
`;
  writeFileSync(path.join(skillDir, "SKILL.md"), skillMd);
  return skillDir;
}

const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit called");
}) as never);

const orgResponse = {
  id: "org-123",
  slug: "user-abc12345",
  displayName: null,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

const storageUploadHandlers = [
  http.post("http://localhost:3000/api/storages/prepare", () => {
    return HttpResponse.json({
      versionId: "a".repeat(64),
      existing: true,
    });
  }),
  http.post("http://localhost:3000/api/storages/commit", () => {
    return HttpResponse.json({
      success: true,
      versionId: "a".repeat(64),
      storageName: "test-storage",
      size: 1000,
      fileCount: 1,
      deduplicated: true,
    });
  }),
];

const composeCreationHandlers = [
  http.get("http://localhost:3000/api/agent/composes", () => {
    return HttpResponse.json(
      { error: { message: "Not found", code: "NOT_FOUND" } },
      { status: 404 },
    );
  }),
  http.post("http://localhost:3000/api/agent/composes", () => {
    return HttpResponse.json({
      composeId: "cmp-123",
      name: "my-agent",
      versionId: "b".repeat(64),
      action: "created",
    });
  }),
  http.get("http://localhost:3000/api/zero/org", () => {
    return HttpResponse.json(orgResponse);
  }),
];

const SLACK_URL = "https://github.com/vm0-ai/vm0-skills/tree/main/slack";
const CUSTOM_URL = "https://github.com/acme/custom-skill/tree/main/tool";

describe("skill resolve integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-skill-resolve-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");
    chalk.level = 0;
    onGitCheckout = undefined;

    server.use(
      http.get("https://registry.npmjs.org/*/latest", () => {
        return HttpResponse.json({ version: "0.0.0-test" });
      }),
    );

    mockSpawn.mockImplementation(() => createMockChildProcess(0) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolved skills skip download and show cached", async () => {
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - slack`,
    );

    let gitCheckoutCalled = false;
    onGitCheckout = () => {
      gitCheckoutCalled = true;
    };

    server.use(
      http.post("http://localhost:3000/api/skills/resolve", () => {
        return HttpResponse.json({
          resolved: {
            [SLACK_URL]: {
              storageName: "agent-skills@vm0-ai/vm0-skills/tree/main/slack",
              versionHash: "c".repeat(64),
              frontmatter: { name: "Slack" },
            },
          },
          unresolved: [],
        });
      }),
      ...composeCreationHandlers,
    );

    await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("(cached)"))).toBe(true);
    expect(allLogs.some((log) => log.includes("slack"))).toBe(true);
    expect(allLogs.some((log) => log.includes("Downloading"))).toBe(false);
    expect(gitCheckoutCalled).toBe(false);
  });

  it("unresolved skills fall back to download and upload", async () => {
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - ${CUSTOM_URL}`,
    );

    onGitCheckout = (cwd) => {
      createMockSkillDir(cwd, "tool");
    };

    server.use(
      http.post("http://localhost:3000/api/skills/resolve", () => {
        return HttpResponse.json({
          resolved: {},
          unresolved: [CUSTOM_URL],
        });
      }),
      ...storageUploadHandlers,
      ...composeCreationHandlers,
    );

    await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("Downloading"))).toBe(true);
    expect(allLogs.some((log) => log.includes("(cached)"))).toBe(false);
  });

  it("mixed resolved and unresolved skills", async () => {
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - slack
      - ${CUSTOM_URL}`,
    );

    onGitCheckout = (cwd) => {
      createMockSkillDir(cwd, "tool");
    };

    server.use(
      http.post("http://localhost:3000/api/skills/resolve", () => {
        return HttpResponse.json({
          resolved: {
            [SLACK_URL]: {
              storageName: "agent-skills@vm0-ai/vm0-skills/tree/main/slack",
              versionHash: "c".repeat(64),
              frontmatter: { name: "Slack" },
            },
          },
          unresolved: [CUSTOM_URL],
        });
      }),
      ...storageUploadHandlers,
      ...composeCreationHandlers,
    );

    await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    expect(allLogs.some((log) => log.includes("(cached)"))).toBe(true);
    expect(allLogs.some((log) => log.includes("Downloading"))).toBe(true);
  });

  it("graceful degradation on 404", async () => {
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - slack`,
    );

    onGitCheckout = (cwd) => {
      createMockSkillDir(cwd, "slack");
    };

    server.use(
      http.post("http://localhost:3000/api/skills/resolve", () => {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }),
      ...storageUploadHandlers,
      ...composeCreationHandlers,
    );

    await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    // Falls back to old flow
    expect(allLogs.some((log) => log.includes("Downloading"))).toBe(true);
    expect(allLogs.some((log) => log.includes("(cached)"))).toBe(false);
  });

  it("graceful degradation on network error", async () => {
    await fs.writeFile(
      path.join(tempDir, "vm0.yaml"),
      `version: "1.0"
agents:
  my-agent:
    framework: claude-code
    skills:
      - slack`,
    );

    onGitCheckout = (cwd) => {
      createMockSkillDir(cwd, "slack");
    };

    server.use(
      http.post("http://localhost:3000/api/skills/resolve", () => {
        return HttpResponse.error();
      }),
      ...storageUploadHandlers,
      ...composeCreationHandlers,
    );

    await composeCommand.parseAsync(["node", "cli", "vm0.yaml", "--yes"]);

    const allLogs = mockConsoleLog.mock.calls
      .map((call) => call[0])
      .filter((log): log is string => typeof log === "string");

    // Falls back to old flow
    expect(allLogs.some((log) => log.includes("Downloading"))).toBe(true);
    expect(allLogs.some((log) => log.includes("(cached)"))).toBe(false);
  });
});
