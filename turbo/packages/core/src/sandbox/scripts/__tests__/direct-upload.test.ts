import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import {
  computeFileHash,
  collectFileMetadata,
  createArchive,
  createManifest,
} from "../src/lib/direct-upload";

describe("direct-upload", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-upload-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeFileHash", () => {
    it("should compute SHA-256 hash of file contents", () => {
      const filePath = path.join(tempDir, "test.txt");
      const content = "Hello, World!";
      fs.writeFileSync(filePath, content);

      // Compute expected hash
      const expectedHash = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      const result = computeFileHash(filePath);

      expect(result).toBe(expectedHash);
    });

    it("should return different hashes for different content", () => {
      const file1 = path.join(tempDir, "file1.txt");
      const file2 = path.join(tempDir, "file2.txt");
      fs.writeFileSync(file1, "content1");
      fs.writeFileSync(file2, "content2");

      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);

      expect(hash1).not.toBe(hash2);
    });

    it("should return same hash for same content", () => {
      const file1 = path.join(tempDir, "file1.txt");
      const file2 = path.join(tempDir, "file2.txt");
      const content = "identical content";
      fs.writeFileSync(file1, content);
      fs.writeFileSync(file2, content);

      const hash1 = computeFileHash(file1);
      const hash2 = computeFileHash(file2);

      expect(hash1).toBe(hash2);
    });

    it("should handle empty files", () => {
      const filePath = path.join(tempDir, "empty.txt");
      fs.writeFileSync(filePath, "");

      const expectedHash = crypto.createHash("sha256").update("").digest("hex");
      const result = computeFileHash(filePath);

      expect(result).toBe(expectedHash);
    });

    it("should handle binary files", () => {
      const filePath = path.join(tempDir, "binary.bin");
      const binaryContent = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
      fs.writeFileSync(filePath, binaryContent);

      const expectedHash = crypto
        .createHash("sha256")
        .update(binaryContent)
        .digest("hex");
      const result = computeFileHash(filePath);

      expect(result).toBe(expectedHash);
    });

    it("should throw for non-existent file", () => {
      expect(() => computeFileHash("/nonexistent/file.txt")).toThrow();
    });
  });

  describe("collectFileMetadata", () => {
    it("should collect metadata for files in directory", () => {
      const file1 = path.join(tempDir, "file1.txt");
      const file2 = path.join(tempDir, "file2.txt");
      fs.writeFileSync(file1, "content1");
      fs.writeFileSync(file2, "content2");

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(2);
      const paths = result.map((f) => f.path).sort();
      expect(paths).toEqual(["file1.txt", "file2.txt"]);

      // Check all entries have required fields
      for (const entry of result) {
        expect(entry.path).toBeDefined();
        expect(entry.hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
        expect(entry.size).toBeGreaterThanOrEqual(0);
      }
    });

    it("should collect metadata recursively", () => {
      const subDir = path.join(tempDir, "subdir");
      fs.mkdirSync(subDir);
      fs.writeFileSync(path.join(tempDir, "root.txt"), "root");
      fs.writeFileSync(path.join(subDir, "nested.txt"), "nested");

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(2);
      const paths = result.map((f) => f.path).sort();
      expect(paths).toContain("root.txt");
      expect(paths).toContain(path.join("subdir", "nested.txt"));
    });

    it("should exclude .git directory", () => {
      const gitDir = path.join(tempDir, ".git");
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, "config"), "git config");
      fs.writeFileSync(path.join(tempDir, "file.txt"), "file");

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("file.txt");
    });

    it("should exclude .vm0 directory", () => {
      const vm0Dir = path.join(tempDir, ".vm0");
      fs.mkdirSync(vm0Dir);
      fs.writeFileSync(path.join(vm0Dir, "data"), "vm0 data");
      fs.writeFileSync(path.join(tempDir, "file.txt"), "file");

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe("file.txt");
    });

    it("should return empty array for empty directory", () => {
      const result = collectFileMetadata(tempDir);

      expect(result).toEqual([]);
    });

    it("should include file size correctly", () => {
      const filePath = path.join(tempDir, "sized.txt");
      const content = "12345"; // 5 bytes
      fs.writeFileSync(filePath, content);

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(1);
      expect(result[0]!.size).toBe(5);
    });

    it("should handle deeply nested directories", () => {
      const deepPath = path.join(tempDir, "a", "b", "c", "d");
      fs.mkdirSync(deepPath, { recursive: true });
      fs.writeFileSync(path.join(deepPath, "deep.txt"), "deep");

      const result = collectFileMetadata(tempDir);

      expect(result).toHaveLength(1);
      expect(result[0]!.path).toBe(path.join("a", "b", "c", "d", "deep.txt"));
    });
  });

  describe("createArchive", () => {
    it("should create tar.gz archive", () => {
      // Use separate source and output directories to avoid "file changed" error
      const sourceDir = path.join(tempDir, "source");
      const outputDir = path.join(tempDir, "output");
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(outputDir);

      fs.writeFileSync(path.join(sourceDir, "file.txt"), "content");
      const archivePath = path.join(outputDir, "archive.tar.gz");

      const result = createArchive(sourceDir, archivePath);

      expect(result).toBe(true);
      expect(fs.existsSync(archivePath)).toBe(true);
      // Archive should be non-empty
      expect(fs.statSync(archivePath).size).toBeGreaterThan(0);
    });

    it("should exclude .git directory from archive", () => {
      const sourceDir = path.join(tempDir, "source");
      const outputDir = path.join(tempDir, "output");
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(outputDir);

      const gitDir = path.join(sourceDir, ".git");
      fs.mkdirSync(gitDir);
      fs.writeFileSync(path.join(gitDir, "config"), "git config");
      fs.writeFileSync(path.join(sourceDir, "file.txt"), "content");

      const archivePath = path.join(outputDir, "archive.tar.gz");
      const result = createArchive(sourceDir, archivePath);

      expect(result).toBe(true);

      // Extract and verify .git is not included
      const extractDir = path.join(tempDir, "extract");
      fs.mkdirSync(extractDir);
      execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

      expect(fs.existsSync(path.join(extractDir, "file.txt"))).toBe(true);
      expect(fs.existsSync(path.join(extractDir, ".git"))).toBe(false);
    });

    it("should exclude .vm0 directory from archive", () => {
      const sourceDir = path.join(tempDir, "source");
      const outputDir = path.join(tempDir, "output");
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(outputDir);

      const vm0Dir = path.join(sourceDir, ".vm0");
      fs.mkdirSync(vm0Dir);
      fs.writeFileSync(path.join(vm0Dir, "data"), "vm0 data");
      fs.writeFileSync(path.join(sourceDir, "file.txt"), "content");

      const archivePath = path.join(outputDir, "archive.tar.gz");
      const result = createArchive(sourceDir, archivePath);

      expect(result).toBe(true);

      // Extract and verify .vm0 is not included
      const extractDir = path.join(tempDir, "extract");
      fs.mkdirSync(extractDir);
      execSync(`tar -xzf "${archivePath}" -C "${extractDir}"`);

      expect(fs.existsSync(path.join(extractDir, "file.txt"))).toBe(true);
      expect(fs.existsSync(path.join(extractDir, ".vm0"))).toBe(false);
    });

    it("should handle empty directory", () => {
      const sourceDir = path.join(tempDir, "empty-source");
      const outputDir = path.join(tempDir, "output");
      fs.mkdirSync(sourceDir);
      fs.mkdirSync(outputDir);

      const archivePath = path.join(outputDir, "empty.tar.gz");

      const result = createArchive(sourceDir, archivePath);

      expect(result).toBe(true);
      expect(fs.existsSync(archivePath)).toBe(true);
    });
  });

  describe("createManifest", () => {
    it("should create manifest JSON file", () => {
      const files = [
        { path: "file1.txt", hash: "abc123", size: 100 },
        { path: "file2.txt", hash: "def456", size: 200 },
      ];
      const manifestPath = path.join(tempDir, "manifest.json");

      const result = createManifest(files, manifestPath);

      expect(result).toBe(true);
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(manifest.version).toBe(1);
      expect(manifest.files).toEqual(files);
      expect(manifest.createdAt).toBeDefined();
      // Verify createdAt is valid ISO timestamp
      expect(new Date(manifest.createdAt).toISOString()).toBe(
        manifest.createdAt,
      );
    });

    it("should handle empty files array", () => {
      const manifestPath = path.join(tempDir, "manifest.json");

      const result = createManifest([], manifestPath);

      expect(result).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      expect(manifest.files).toEqual([]);
    });

    it("should format JSON with indentation", () => {
      const files = [{ path: "test.txt", hash: "xyz", size: 50 }];
      const manifestPath = path.join(tempDir, "manifest.json");

      createManifest(files, manifestPath);

      const content = fs.readFileSync(manifestPath, "utf-8");
      // Should be formatted with 2-space indentation
      expect(content).toContain("  ");
      expect(content.split("\n").length).toBeGreaterThan(1);
    });

    it("should return false for invalid path", () => {
      const files = [{ path: "test.txt", hash: "abc", size: 10 }];
      const invalidPath = "/nonexistent/dir/manifest.json";

      const result = createManifest(files, invalidPath);

      expect(result).toBe(false);
    });
  });
});
