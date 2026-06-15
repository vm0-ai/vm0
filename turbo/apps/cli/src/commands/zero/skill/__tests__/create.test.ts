/**
 * Tests for zero skill create command
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

const mockSkill = {
  name: "my-skill",
  displayName: "My Skill",
  description: "A test skill",
};

describe("zero skill create command", () => {
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

    skillDir = join(tmpdir(), `test-skill-${Date.now()}`);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Test Skill\nDo things.");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    rmSync(skillDir, { recursive: true, force: true });
  });

  describe("successful create", () => {
    it("should send all files from directory", async () => {
      // Add a supporting file
      mkdirSync(join(skillDir, "templates"), { recursive: true });
      writeFileSync(
        join(skillDir, "templates", "prompt.md"),
        "You are a helpful assistant.",
      );

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/skills",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockSkill, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-skill",
        "--dir",
        skillDir,
        "--display-name",
        "My Skill",
        "--description",
        "A test skill",
      ]);

      expect(capturedBody?.name).toBe("my-skill");
      expect(capturedBody?.displayName).toBe("My Skill");

      const files = capturedBody?.files as Array<{
        path: string;
        content: string;
      }>;
      expect(files).toHaveLength(2);
      expect(
        files.find((f) => {
          return f.path === "SKILL.md";
        })?.content,
      ).toBe("# Test Skill\nDo things.");
      expect(
        files.find((f) => {
          return f.path === "templates/prompt.md";
        })?.content,
      ).toBe("You are a helpful assistant.");

      const logCalls = mockConsoleLog.mock.calls.flat().join("\n");
      expect(logCalls).toContain("my-skill");
      expect(logCalls).toContain("created");
      expect(logCalls).toContain("2 file(s)");
    });

    it("should exclude hidden files and node_modules", async () => {
      writeFileSync(join(skillDir, ".hidden"), "secret");
      mkdirSync(join(skillDir, "node_modules"), { recursive: true });
      writeFileSync(join(skillDir, "node_modules", "pkg.js"), "module");

      let capturedBody: Record<string, unknown> | undefined;
      server.use(
        http.post(
          "http://localhost:3000/api/zero/skills",
          async ({ request }) => {
            capturedBody = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json(mockSkill, { status: 201 });
          },
        ),
      );

      await createCommand.parseAsync([
        "node",
        "cli",
        "my-skill",
        "--dir",
        skillDir,
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
      const emptyDir = join(tmpdir(), `empty-skill-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      await expect(async () => {
        await createCommand.parseAsync([
          "node",
          "cli",
          "my-skill",
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
        http.post("http://localhost:3000/api/zero/skills", () => {
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
          "my-skill",
          "--dir",
          skillDir,
        ]);
      }).rejects.toThrow("process.exit called");

      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
