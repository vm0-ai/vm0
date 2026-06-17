/**
 * Tests for zero workflow edit command
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
import { editCommand } from "../edit";
import chalk from "chalk";

describe("zero workflow edit command", () => {
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

    workflowDir = join(tmpdir(), `test-workflow-edit-${Date.now()}`);
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, "SKILL.md"),
      "# Updated Workflow\nNew content.",
    );
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(workflowDir, { recursive: true, force: true });
  });

  describe("successful edit", () => {
    it("should send all files from directory", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.put(
          "http://localhost:3000/api/zero/workflows/my-workflow",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              name: "my-workflow",
              displayName: "My Workflow",
              description: null,
              visibility: "private",
              ownerUserId: "user-123",
              attachedAgentCount: 0,
              attachedAgents: [],
              canManage: true,
              content: "# Updated Workflow\nNew content.",
              files: [{ path: "SKILL.md", size: 28 }],
            });
          },
        ),
      );

      await editCommand.parseAsync([
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
      expect(files?.[0]?.content).toBe("# Updated Workflow\nNew content.");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-workflow");
      expect(logCalls).toContain("updated");
      expect(logCalls).toContain("1 file(s)");
    });
  });

  describe("error handling", () => {
    it("should fail when SKILL.md not found", async () => {
      const emptyDir = join(tmpdir(), `empty-workflow-edit-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      await expect(async () => {
        await editCommand.parseAsync([
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
  });
});
