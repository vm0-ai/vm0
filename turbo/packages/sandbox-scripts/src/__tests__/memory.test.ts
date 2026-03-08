import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { encodeProjectName } from "../scripts/lib/common.js";
import { setupAutoMemorySymlink } from "../scripts/lib/memory.js";

describe("encodeProjectName", () => {
  it("should encode standard paths", () => {
    expect(encodeProjectName("/home/user/workspace")).toBe(
      "-home-user-workspace",
    );
  });

  it("should handle root path", () => {
    expect(encodeProjectName("/")).toBe("-");
  });

  it("should handle deeply nested paths", () => {
    expect(encodeProjectName("/a/b/c/d/e/f")).toBe("-a-b-c-d-e-f");
  });

  it("should handle path without leading slash", () => {
    expect(encodeProjectName("relative/path")).toBe("-relative-path");
  });

  it("should match existing session history encoding", () => {
    // This encoding is used for session history in events.ts and mock-claude.ts.
    // Verify consistency with the established pattern.
    const workingDir = "/workspaces/my-project";
    const encoded = encodeProjectName(workingDir);
    expect(encoded).toBe("-workspaces-my-project");

    // The full session history path would be:
    // ~/.claude/projects/{encoded}/{sessionId}.jsonl
    const fullPath = `/home/user/.claude/projects/${encoded}/session.jsonl`;
    expect(fullPath).toBe(
      "/home/user/.claude/projects/-workspaces-my-project/session.jsonl",
    );
  });
});

describe("setupAutoMemorySymlink", () => {
  let tempDir: string;
  let memoryDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
    memoryDir = path.join(tempDir, "memory-mount");
    fs.mkdirSync(memoryDir);
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should create symlink when memory mount exists", () => {
    const result = setupAutoMemorySymlink(
      "/home/user/workspace",
      memoryDir,
      "claude-code",
    );

    expect(result).toBe(true);

    const expectedPath = path.join(
      tempDir,
      ".claude",
      "projects",
      "-home-user-workspace",
      "memory",
    );
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.lstatSync(expectedPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(expectedPath)).toBe(memoryDir);
  });

  it("should return false when agent type is codex", () => {
    const result = setupAutoMemorySymlink(
      "/home/user/workspace",
      memoryDir,
      "codex",
    );

    expect(result).toBe(false);
  });

  it("should return false when memory mount path is empty", () => {
    const result = setupAutoMemorySymlink(
      "/home/user/workspace",
      "",
      "claude-code",
    );

    expect(result).toBe(false);
  });

  it("should return false when memory mount path does not exist", () => {
    const result = setupAutoMemorySymlink(
      "/home/user/workspace",
      "/nonexistent/path",
      "claude-code",
    );

    expect(result).toBe(false);
  });

  it("should return false when auto-memory dir already exists", () => {
    // Pre-create the target directory
    const autoMemoryDir = path.join(
      tempDir,
      ".claude",
      "projects",
      "-home-user-workspace",
      "memory",
    );
    fs.mkdirSync(autoMemoryDir, { recursive: true });

    const result = setupAutoMemorySymlink(
      "/home/user/workspace",
      memoryDir,
      "claude-code",
    );

    expect(result).toBe(false);
    // Original directory should still be a directory, not a symlink
    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(false);
  });

  it("should create parent directories", () => {
    const result = setupAutoMemorySymlink(
      "/deep/nested/path",
      memoryDir,
      "claude-code",
    );

    expect(result).toBe(true);
    const parentDir = path.join(
      tempDir,
      ".claude",
      "projects",
      "-deep-nested-path",
    );
    expect(fs.existsSync(parentDir)).toBe(true);
  });

  it("should resolve symlink to memory mount contents", () => {
    // Create a MEMORY.md in the memory mount
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Test Memory\n");

    setupAutoMemorySymlink("/home/user/workspace", memoryDir, "claude-code");

    // Read through the symlink
    const autoMemoryPath = path.join(
      tempDir,
      ".claude",
      "projects",
      "-home-user-workspace",
      "memory",
      "MEMORY.md",
    );
    expect(fs.readFileSync(autoMemoryPath, "utf-8")).toBe("# Test Memory\n");
  });
});
