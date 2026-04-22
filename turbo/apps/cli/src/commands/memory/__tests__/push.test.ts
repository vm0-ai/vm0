/**
 * Tests for memory push command
 *
 * Covers:
 * - Config validation (no config, wrong type)
 * - Legacy type:memory dir rejection after storage-utils compat
 *
 * The push happy path is exercised via E2E — removal of `vm0 memory push`
 * itself is tracked in sibling sub-issues of #10577.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pushCommand } from "../push";
import { mkdtempSync, rmSync } from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";

describe("memory push", () => {
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
    chalk.level = 0;
    vi.stubEnv("VM0_API_URL", "http://localhost:3000");
    vi.stubEnv("VM0_TOKEN", "test-token");

    // Setup temp directory
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-memory-push-"));
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

  describe("config validation", () => {
    it("should fail if no config exists", async () => {
      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("No memory initialized"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 memory init"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail if config type is volume", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-volume\ntype: volume",
      );

      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as a volume"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 volume push"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it("should fail if config type is artifact", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: my-artifact\ntype: artifact",
      );

      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as an artifact"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact push"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe("legacy type: memory dirs", () => {
    // After the storage-utils one-release compat lands, `type: memory` is
    // normalised to `artifact` at read time. `vm0 memory push` therefore
    // rejects such dirs and directs users to `vm0 artifact push`. Removal of
    // `vm0 memory push` itself is tracked in sibling sub-issues of #10577.
    it("should reject legacy type: memory dirs as artifact", async () => {
      await fs.mkdir(path.join(tempDir, ".vm0"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".vm0", "storage.yaml"),
        "name: test-memory\ntype: memory",
      );

      await expect(async () => {
        await pushCommand.parseAsync(["node", "cli"]);
      }).rejects.toThrow("process.exit called");

      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("initialized as an artifact"),
      );
      expect(mockConsoleError).toHaveBeenCalledWith(
        expect.stringContaining("vm0 artifact push"),
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
