import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupClaudeCommand } from "../setup-claude";
import * as fs from "fs/promises";
import { existsSync, mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";

describe("setup-claude command", () => {
  let tempDir: string;
  let originalCwd: string;

  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-setup-claude-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  describe("successful download", () => {
    it("should create .claude/skills/vm0-agent-builder directory", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(
        existsSync(path.join(tempDir, ".claude/skills/vm0-agent-builder")),
      ).toBe(true);
    });

    it("should download SKILL.md from GitHub", async () => {
      const skillContent = `---
name: vm0-agent-builder
description: Test skill
---
# VM0 Agent Builder
Test content`;

      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([
              { name: "SKILL.md", type: "file", download_url: null },
            ]);
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
          () => {
            return HttpResponse.text(skillContent);
          },
        ),
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const downloadedContent = await fs.readFile(
        path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        "utf8",
      );
      expect(downloadedContent).toBe(skillContent);
    });

    it("should download multiple files from the skill directory", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([
              { name: "SKILL.md", type: "file", download_url: null },
              { name: "README.md", type: "file", download_url: null },
            ]);
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
          () => {
            return HttpResponse.text("# Skill content");
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/README.md",
          () => {
            return HttpResponse.text("# README content");
          },
        ),
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(
        existsSync(
          path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(tempDir, ".claude/skills/vm0-agent-builder/README.md"),
        ),
      ).toBe(true);
    });

    it("should overwrite existing files (idempotent)", async () => {
      // Create existing skill directory with old content
      await fs.mkdir(path.join(tempDir, ".claude/skills/vm0-agent-builder"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        "old content",
      );

      const newContent = "# New skill content";
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([
              { name: "SKILL.md", type: "file", download_url: null },
            ]);
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
          () => {
            return HttpResponse.text(newContent);
          },
        ),
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      const content = await fs.readFile(
        path.join(tempDir, ".claude/skills/vm0-agent-builder/SKILL.md"),
        "utf8",
      );
      expect(content).toBe(newContent);
    });

    it("should display success message and next steps", async () => {
      await setupClaudeCommand.parseAsync(["node", "cli"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("Installed vm0-agent-builder skill"),
      );
      expect(mockConsoleLog).toHaveBeenCalledWith("Next step:");
      expect(mockConsoleLog).toHaveBeenCalledWith(
        expect.stringContaining("/vm0-agent-builder"),
      );
    });

    it("should skip directories in the listing", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([
              { name: "SKILL.md", type: "file", download_url: null },
              { name: "subdir", type: "dir", download_url: null },
            ]);
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
          () => {
            return HttpResponse.text("# Skill content");
          },
        ),
      );

      await setupClaudeCommand.parseAsync(["node", "cli"]);

      // Should only have SKILL.md, not the directory
      const files = await fs.readdir(
        path.join(tempDir, ".claude/skills/vm0-agent-builder"),
      );
      expect(files).toEqual(["SKILL.md"]);
    });
  });

  describe("error handling", () => {
    it("should throw error when GitHub API fails", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return new HttpResponse(null, {
              status: 404,
              statusText: "Not Found",
            });
          },
        ),
      );

      await expect(async () => {
        await setupClaudeCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow();
    });

    it("should exit with error when no files found", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([]);
          },
        ),
      );

      await expect(async () => {
        await setupClaudeCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No skill files found"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should throw error when file download fails", async () => {
      server.use(
        http.get(
          "https://api.github.com/repos/vm0-ai/vm0/contents/docs/vm0-agent-builder",
          () => {
            return HttpResponse.json([
              { name: "SKILL.md", type: "file", download_url: null },
            ]);
          },
        ),
        http.get(
          "https://raw.githubusercontent.com/vm0-ai/vm0/main/docs/vm0-agent-builder/SKILL.md",
          () => {
            return new HttpResponse(null, {
              status: 500,
              statusText: "Internal Server Error",
            });
          },
        ),
      );

      await expect(async () => {
        await setupClaudeCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow();
    });
  });
});
