import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import {
  excludeVm0Filter,
  listTarFiles,
  removeExtraFiles,
} from "../file-utils";

describe("file-utils", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-utils-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("excludeVm0Filter", () => {
    it("should exclude .vm0 directory", () => {
      expect(excludeVm0Filter(".vm0")).toBe(false);
    });

    it("should exclude .vm0/ paths", () => {
      expect(excludeVm0Filter(".vm0/")).toBe(false);
      expect(excludeVm0Filter(".vm0/config.yaml")).toBe(false);
    });

    it("should exclude ./.vm0 paths (tar prefix format)", () => {
      expect(excludeVm0Filter("./.vm0")).toBe(false);
      expect(excludeVm0Filter("./.vm0/")).toBe(false);
      expect(excludeVm0Filter("./.vm0/config.yaml")).toBe(false);
    });

    it("should include regular files", () => {
      expect(excludeVm0Filter("file.txt")).toBe(true);
      expect(excludeVm0Filter("src/index.ts")).toBe(true);
      expect(excludeVm0Filter("./file.txt")).toBe(true);
    });

    it("should include files with vm0 in name but not .vm0 directory", () => {
      expect(excludeVm0Filter("vm0-config.txt")).toBe(true);
      expect(excludeVm0Filter("my.vm0.txt")).toBe(true);
    });
  });

  describe("listTarFiles", () => {
    it("should extract file paths from tar.gz", async () => {
      // Create source files
      const sourceDir = path.join(tempDir, "source");
      fs.mkdirSync(sourceDir);
      fs.writeFileSync(path.join(sourceDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(sourceDir, "file2.txt"), "content2");

      // Create tar.gz
      const tarPath = path.join(tempDir, "test.tar.gz");
      await tar.create({ gzip: true, file: tarPath, cwd: sourceDir }, [
        "file1.txt",
        "file2.txt",
      ]);

      const files = await listTarFiles(tarPath);

      expect(files.length).toBe(2);
      expect(files).toContain("file1.txt");
      expect(files).toContain("file2.txt");
    });

    it("should handle nested paths", async () => {
      // Create nested source files
      const sourceDir = path.join(tempDir, "source");
      const subDir = path.join(sourceDir, "dir", "subdir");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "file.txt"), "content");

      // Create tar.gz
      const tarPath = path.join(tempDir, "test.tar.gz");
      await tar.create({ gzip: true, file: tarPath, cwd: sourceDir }, [
        "dir/subdir/file.txt",
      ]);

      const files = await listTarFiles(tarPath);

      expect(files.length).toBe(1);
      expect(files).toContain("dir/subdir/file.txt");
    });

    it("should return empty array for empty tar.gz", async () => {
      // Create empty source directory
      const sourceDir = path.join(tempDir, "source");
      fs.mkdirSync(sourceDir);

      // Create tar.gz of empty directory
      const tarPath = path.join(tempDir, "test.tar.gz");
      await tar.create({ gzip: true, file: tarPath, cwd: sourceDir }, ["."]);

      const files = await listTarFiles(tarPath);

      expect(files.length).toBe(0);
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
