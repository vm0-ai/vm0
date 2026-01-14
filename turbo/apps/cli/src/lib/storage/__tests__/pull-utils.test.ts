import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { handleEmptyStorageResponse } from "../pull-utils";

describe("pull-utils", () => {
  let tempDir: string;
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(async () => {
    vi.clearAllMocks();
    // Create a unique temp directory for each test
    tempDir = path.join(os.tmpdir(), `pull-utils-test-${Date.now()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("handleEmptyStorageResponse", () => {
    it("should remove all files when syncing to empty state", async () => {
      // Create some files in the temp directory
      await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
      await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");
      const subDir = path.join(tempDir, "subdir");
      await fs.promises.mkdir(subDir, { recursive: true });
      await fs.promises.writeFile(path.join(subDir, "file3.txt"), "content3");

      // Handle empty storage response
      const result = await handleEmptyStorageResponse(tempDir);

      // Verify files were removed
      expect(result.removedCount).toBe(3);

      // Verify the directory only contains .vm0 (if any) or is empty
      const remainingFiles = await fs.promises.readdir(tempDir);
      expect(remainingFiles.filter((f) => f !== ".vm0")).toHaveLength(0);
    });

    it("should return 0 removedCount when directory is already empty", async () => {
      // Directory is already empty
      const result = await handleEmptyStorageResponse(tempDir);

      // Verify no files were removed
      expect(result.removedCount).toBe(0);
    });

    it("should preserve .vm0 directory", async () => {
      // Create .vm0 directory with config
      const vm0Dir = path.join(tempDir, ".vm0");
      await fs.promises.mkdir(vm0Dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(vm0Dir, "storage.yaml"),
        "name: test",
      );

      // Create other files that should be removed
      await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content");

      // Handle empty storage response
      const result = await handleEmptyStorageResponse(tempDir);

      // Verify only non-.vm0 files were removed
      expect(result.removedCount).toBe(1);

      // Verify .vm0 directory still exists
      const vm0Exists = fs.existsSync(vm0Dir);
      expect(vm0Exists).toBe(true);

      // Verify .vm0 config still exists
      const configExists = fs.existsSync(path.join(vm0Dir, "storage.yaml"));
      expect(configExists).toBe(true);
    });

    it("should log correct messages", async () => {
      // Create a file to be removed
      await fs.promises.writeFile(path.join(tempDir, "file.txt"), "content");

      await handleEmptyStorageResponse(tempDir);

      // Verify log messages
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Syncing local files..."),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Removed 1 files not in remote"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Synced (0 files)"),
      );
    });

    it("should not log removal count when no files removed", async () => {
      // Directory is empty
      await handleEmptyStorageResponse(tempDir);

      // Verify log messages - should NOT contain removal message
      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      const hasRemovalMessage = calls.some(
        (msg) => typeof msg === "string" && msg.includes("Removed"),
      );
      expect(hasRemovalMessage).toBe(false);

      // Should still log sync message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Synced (0 files)"),
      );
    });
  });
});
