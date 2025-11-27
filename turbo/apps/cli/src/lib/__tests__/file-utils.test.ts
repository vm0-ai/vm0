import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { listLocalFiles, removeExtraFiles } from "../file-utils";

describe("file-utils", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-utils-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("listLocalFiles", () => {
    it("should list all files in a directory", async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(tempDir, "file2.txt"), "content2");

      const files = await listLocalFiles(tempDir);

      expect(files).toHaveLength(2);
      expect(files).toContain("file1.txt");
      expect(files).toContain("file2.txt");
    });

    it("should list files in nested directories", async () => {
      // Create nested structure
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, "root.txt"), "root");
      fs.writeFileSync(path.join(subDir, "nested.txt"), "nested");

      const files = await listLocalFiles(tempDir);

      expect(files).toHaveLength(2);
      expect(files).toContain("root.txt");
      expect(files).toContain(path.join("subdir", "nested.txt"));
    });

    it("should exclude .vm0 directory by default", async () => {
      // Create files including .vm0 directory
      fs.writeFileSync(path.join(tempDir, "file.txt"), "content");
      const vm0Dir = path.join(tempDir, ".vm0");
      fs.mkdirSync(vm0Dir);
      fs.writeFileSync(path.join(vm0Dir, "storage.yaml"), "name: test");

      const files = await listLocalFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files).toContain("file.txt");
      expect(files).not.toContain(path.join(".vm0", "storage.yaml"));
    });

    it("should allow custom exclude directories", async () => {
      // Create files
      fs.writeFileSync(path.join(tempDir, "file.txt"), "content");
      const nodeModules = path.join(tempDir, "node_modules");
      fs.mkdirSync(nodeModules);
      fs.writeFileSync(path.join(nodeModules, "package.json"), "{}");

      const files = await listLocalFiles(tempDir, ["node_modules"]);

      expect(files).toHaveLength(1);
      expect(files).toContain("file.txt");
    });

    it("should return empty array for empty directory", async () => {
      const files = await listLocalFiles(tempDir);

      expect(files).toHaveLength(0);
    });

    it("should handle deeply nested structures", async () => {
      // Create deep structure
      const deepDir = path.join(tempDir, "a", "b", "c");
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(path.join(deepDir, "deep.txt"), "deep");

      const files = await listLocalFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files).toContain(path.join("a", "b", "c", "deep.txt"));
    });
  });

  describe("removeExtraFiles", () => {
    it("should remove files not in remote set", async () => {
      // Create local files
      fs.writeFileSync(path.join(tempDir, "keep.txt"), "keep");
      fs.writeFileSync(path.join(tempDir, "remove.txt"), "remove");

      // Remote only has keep.txt
      const remoteFiles = new Set(["keep.txt"]);

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(1);
      expect(fs.existsSync(path.join(tempDir, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, "remove.txt"))).toBe(false);
    });

    it("should not remove files in .vm0 directory", async () => {
      // Create files
      fs.writeFileSync(path.join(tempDir, "file.txt"), "content");
      const vm0Dir = path.join(tempDir, ".vm0");
      fs.mkdirSync(vm0Dir);
      fs.writeFileSync(path.join(vm0Dir, "storage.yaml"), "name: test");

      // Remote is empty
      const remoteFiles = new Set<string>();

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(1);
      expect(fs.existsSync(path.join(tempDir, "file.txt"))).toBe(false);
      expect(fs.existsSync(path.join(vm0Dir, "storage.yaml"))).toBe(true);
    });

    it("should remove files in nested directories", async () => {
      // Create nested structure
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "keep.txt"), "keep");
      fs.writeFileSync(path.join(subDir, "remove.txt"), "remove");

      const remoteFiles = new Set(["subdir/keep.txt"]);

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(1);
      expect(fs.existsSync(path.join(subDir, "keep.txt"))).toBe(true);
      expect(fs.existsSync(path.join(subDir, "remove.txt"))).toBe(false);
    });

    it("should clean up empty directories after removal", async () => {
      // Create nested structure where entire directory becomes empty
      const subDir = path.join(tempDir, "emptyafter");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "remove.txt"), "remove");

      const remoteFiles = new Set<string>();

      await removeExtraFiles(tempDir, remoteFiles);

      expect(fs.existsSync(subDir)).toBe(false);
    });

    it("should not remove non-empty directories", async () => {
      // Create nested structure
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "keep.txt"), "keep");
      fs.writeFileSync(path.join(subDir, "remove.txt"), "remove");

      const remoteFiles = new Set(["subdir/keep.txt"]);

      await removeExtraFiles(tempDir, remoteFiles);

      expect(fs.existsSync(subDir)).toBe(true);
    });

    it("should return 0 when no files need removal", async () => {
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(tempDir, "file2.txt"), "content2");

      const remoteFiles = new Set(["file1.txt", "file2.txt"]);

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(0);
    });

    it("should handle empty local directory", async () => {
      const remoteFiles = new Set(["file.txt"]);

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(0);
    });

    it("should handle path separator differences", async () => {
      // Create nested file
      const subDir = path.join(tempDir, "sub");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(subDir, "file.txt"), "content");

      // Remote uses forward slashes
      const remoteFiles = new Set(["sub/file.txt"]);

      const removedCount = await removeExtraFiles(tempDir, remoteFiles);

      expect(removedCount).toBe(0);
      expect(fs.existsSync(path.join(subDir, "file.txt"))).toBe(true);
    });
  });
});
