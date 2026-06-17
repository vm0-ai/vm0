/**
 * Tests for zero workflow create command
 *
 * Tests command-level behavior via parseAsync() following CLI testing principles:
 * - Entry point: command.parseAsync()
 * - Mock (external): Web API via MSW
 * - Real (internal): All CLI code, formatters, validators
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../../../../mocks/server";
import { createCommand } from "../create";
import chalk from "chalk";

const mockWorkflow = {
  name: "my-workflow",
  displayName: "My Workflow",
  description: "A test workflow",
  visibility: "private",
  ownerUserId: "user-123",
  attachedAgentCount: 0,
  attachedAgents: [],
  canManage: true,
};

describe("zero workflow create command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let workflowDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    workflowDir = join(tmpdir(), `test-workflow-${Date.now()}`);
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(workflowDir, "SKILL.md"), "# Test Workflow\nDo things.");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(workflowDir, { recursive: true, force: true });
  });

  describe("successful create", () => {
    it("should send all files from directory", async () => {
      // Add a supporting file
      mkdirSync(join(workflowDir, "templates"), { recursive: true });
      writeFileSync(
        join(workflowDir, "templates", "prompt.md"),
        "You are a helpful assistant.",
      );

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflows",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockWorkflow, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-workflow",
        "--dir",
        workflowDir,
        "--display-name",
        "My Workflow",
        "--description",
        "A test workflow",
      ]);

      expect(capturedBody?.name).toBe("my-workflow");
      expect(capturedBody?.displayName).toBe("My Workflow");

      const files = capturedBody?.files as Array<{
        path: string;
        content: string;
      }>;
      expect(files).toHaveLength(2);
      expect(
        files.find((f) => {
          return f.path === "SKILL.md";
        })?.content,
      ).toBe("# Test Workflow\nDo things.");
      expect(
        files.find((f) => {
          return f.path === "templates/prompt.md";
        })?.content,
      ).toBe("You are a helpful assistant.");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("created");
      expect(logCalls).toContain("2 file(s)");
    });

    it("should exclude hidden files and node_modules", async () => {
      writeFileSync(join(workflowDir, ".hidden"), "secret");
      mkdirSync(join(workflowDir, "node_modules"), { recursive: true });
      writeFileSync(join(workflowDir, "node_modules", "pkg.js"), "module");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/workflows",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockWorkflow, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-workflow",
        "--dir",
        workflowDir,
      ]);

      const files = capturedBody?.files as
        | Array<{ path: string; content: string }>
        | undefined;
      expect(files).toBeDefined();
      expect(files).toHaveLength(1);
      expect(files?.[0]?.path).toBe("SKILL.md");
    });
  });

  describe("error handling", () => {
    it("should fail when SKILL.md not found in directory", async () => {
      const emptyDir = join(tmpdir(), `empty-workflow-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-workflow",
          "--dir",
          emptyDir,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("SKILL.md not found"),
      );

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it("should handle authentication error", async () => {
      server.use(
        http.post("http://localhost:3000/api/zero/workflows", () => {
          return HttpResponse.json(
            { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
            { status: 401 },
          );
        }),
      );

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-workflow",
          "--dir",
          workflowDir,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
