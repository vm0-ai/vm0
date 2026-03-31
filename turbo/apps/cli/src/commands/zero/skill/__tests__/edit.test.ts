/**
 * Tests for zero skill edit command
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

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("zero skill edit command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  let skillDir: string;

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    skillDir = join(tmpdir(), `test-skill-edit-${Date.now()}`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Updated Skill\nNew content.");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(skillDir, { recursive: true, force: true });
  });

  describe("successful edit", () => {
    it("should update skill content from directory", async () => {
      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.put(
          `http://localhost:3000/api/zero/agents/${AGENT_ID}/skills/my-skill`,
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({
              name: "my-skill",
              displayName: "My Skill",
              description: null,
              content: "# Updated Skill\nNew content.",
            });
          },
        ),
      );

      await editCommand.parseAsync([
        "node",
        "cli",
        "my-skill",
        "--dir",
        skillDir,
        "--agent",
        AGENT_ID,
      ]);

      expect(capturedBody?.content).toBe("# Updated Skill\nNew content.");
      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-skill");
      expect(logCalls).toContain("updated");
    });
  });

  describe("error handling", () => {
    it("should fail when SKILL.md not found", async () => {
      const emptyDir = join(tmpdir(), `empty-skill-edit-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      await expect(async () => {
        await editCommand.parseAsync([
          "node",
          "cli",
          "my-skill",
          "--dir",
          emptyDir,
          "--agent",
          AGENT_ID,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("SKILL.md not found"),
      );

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });
});
