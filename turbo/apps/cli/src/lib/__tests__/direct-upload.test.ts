import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as tar from "tar";
import {
  hashFileContent,
  hashFileStream,
  getAllFiles,
  collectFileMetadata,
  createArchive,
  createManifest,
  type FileEntryWithHash,
} from "../direct-upload";

describe("direct-upload", () => {
  describe("hashFileContent", () => {
    it("should compute SHA-256 hash of content", () => {
      const content = Buffer.from("hello world");
      const hash = hashFileContent(content);

      // SHA-256 of "hello world"
      expect(hash).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      );
    });

    it("should produce 64-character hex string", () => {
      const content = Buffer.from("test content");
      const hash = hashFileContent(content);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should be deterministic", () => {
      const content = Buffer.from("same content");
      const hash1 = hashFileContent(content);
      const hash2 = hashFileContent(content);

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different content", () => {
      const hash1 = hashFileContent(Buffer.from("content a"));
      const hash2 = hashFileContent(Buffer.from("content b"));

      expect(hash1).not.toBe(hash2);
    });

    it("should handle empty content", () => {
      const hash = hashFileContent(Buffer.from(""));

      expect(hash).toHaveLength(64);
      // SHA-256 of empty string
      expect(hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });

    it("should handle binary content", () => {
      const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const hash = hashFileContent(content);

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("hashFileStream", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hash-stream-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should compute same hash as hashFileContent", async () => {
      const content = "hello world";
      const filePath = path.join(tempDir, "test.txt");
      fs.writeFileSync(filePath, content);

      const streamHash = await hashFileStream(filePath);
      const bufferHash = hashFileContent(Buffer.from(content));

      expect(streamHash).toBe(bufferHash);
    });

    it("should handle empty files", async () => {
      const filePath = path.join(tempDir, "empty.txt");
      fs.writeFileSync(filePath, "");

      const hash = await hashFileStream(filePath);

      // SHA-256 of empty string
      expect(hash).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });

    it("should handle binary files", async () => {
      const filePath = path.join(tempDir, "binary.bin");
      fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0xff]));

      const streamHash = await hashFileStream(filePath);
      const bufferHash = hashFileContent(Buffer.from([0x00, 0x01, 0x02, 0xff]));

      expect(streamHash).toBe(bufferHash);
    });

    it("should be deterministic", async () => {
      const filePath = path.join(tempDir, "test.txt");
      fs.writeFileSync(filePath, "deterministic content");

      const hash1 = await hashFileStream(filePath);
      const hash2 = await hashFileStream(filePath);

      expect(hash1).toBe(hash2);
    });
  });

  describe("getAllFiles", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-upload-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should list all files in directory", async () => {
      // Create test files
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(tempDir, "file2.txt"), "content2");

      const files = await getAllFiles(tempDir);

      expect(files).toHaveLength(2);
      expect(files.map((f) => path.basename(f)).sort()).toEqual([
        "file1.txt",
        "file2.txt",
      ]);
    });

    it("should recursively list files in subdirectories", async () => {
      // Create nested structure
      fs.mkdirSync(path.join(tempDir, "subdir"));
      fs.writeFileSync(path.join(tempDir, "root.txt"), "root");
      fs.writeFileSync(path.join(tempDir, "subdir", "nested.txt"), "nested");

      const files = await getAllFiles(tempDir);

      expect(files).toHaveLength(2);
      const fileNames = files.map((f) => path.basename(f)).sort();
      expect(fileNames).toEqual(["nested.txt", "root.txt"]);
    });

    it("should exclude .vm0 directory", async () => {
      // Create files including .vm0
      fs.writeFileSync(path.join(tempDir, "file.txt"), "content");
      fs.mkdirSync(path.join(tempDir, ".vm0"));
      fs.writeFileSync(path.join(tempDir, ".vm0", "config.yaml"), "config");

      const files = await getAllFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(path.basename(files[0]!)).toBe("file.txt");
    });

    it("should return empty array for empty directory", async () => {
      const files = await getAllFiles(tempDir);

      expect(files).toEqual([]);
    });

    it("should handle deeply nested directories", async () => {
      // Create deep nesting
      const deepPath = path.join(tempDir, "a", "b", "c", "d");
      fs.mkdirSync(deepPath, { recursive: true });
      fs.writeFileSync(path.join(deepPath, "deep.txt"), "deep content");

      const files = await getAllFiles(tempDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain("deep.txt");
    });
  });

  describe("collectFileMetadata", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-upload-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should collect file metadata with hashes", async () => {
      fs.writeFileSync(path.join(tempDir, "test.txt"), "test content");

      const files = await getAllFiles(tempDir);
      const metadata = await collectFileMetadata(tempDir, files);

      expect(metadata).toHaveLength(1);
      expect(metadata[0]!.path).toBe("test.txt");
      expect(metadata[0]!.size).toBe(12); // "test content" length
      expect(metadata[0]!.hash).toHaveLength(64);
    });

    it("should compute correct relative paths", async () => {
      fs.mkdirSync(path.join(tempDir, "subdir"));
      fs.writeFileSync(path.join(tempDir, "subdir", "nested.txt"), "content");

      const files = await getAllFiles(tempDir);
      const metadata = await collectFileMetadata(tempDir, files);

      expect(metadata[0]!.path).toBe(path.join("subdir", "nested.txt"));
    });

    it("should handle multiple files", async () => {
      fs.writeFileSync(path.join(tempDir, "a.txt"), "content a");
      fs.writeFileSync(path.join(tempDir, "b.txt"), "content b");

      const files = await getAllFiles(tempDir);
      const metadata = await collectFileMetadata(tempDir, files);

      expect(metadata).toHaveLength(2);
      expect(metadata.every((m) => m.hash.length === 64)).toBe(true);
    });

    it("should call progress callback", async () => {
      // Create 150 files to trigger progress callback
      for (let i = 0; i < 150; i++) {
        fs.writeFileSync(path.join(tempDir, `file${i}.txt`), `content ${i}`);
      }

      const files = await getAllFiles(tempDir);
      const progressMessages: string[] = [];

      await collectFileMetadata(tempDir, files, (msg) => {
        progressMessages.push(msg);
      });

      expect(progressMessages.length).toBeGreaterThan(0);
      expect(progressMessages[0]).toContain("Hashing files...");
    });
  });

  describe("createArchive", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "direct-upload-test-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("should create valid tar.gz archive", async () => {
      fs.writeFileSync(path.join(tempDir, "test.txt"), "test content");

      const files = await getAllFiles(tempDir);
      const archive = await createArchive(tempDir, files);

      // Archive should be a Buffer
      expect(archive).toBeInstanceOf(Buffer);
      expect(archive.length).toBeGreaterThan(0);

      // Verify it's a valid gzip file (starts with 1f 8b)
      expect(archive[0]).toBe(0x1f);
      expect(archive[1]).toBe(0x8b);
    });

    it("should include all files in archive", async () => {
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "content1");
      fs.writeFileSync(path.join(tempDir, "file2.txt"), "content2");

      const files = await getAllFiles(tempDir);
      const archive = await createArchive(tempDir, files);

      // Extract and verify
      const extractDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "extract-test-"),
      );
      const archivePath = path.join(extractDir, "test.tar.gz");
      fs.writeFileSync(archivePath, archive);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      expect(fs.existsSync(path.join(extractDir, "file1.txt"))).toBe(true);
      expect(fs.existsSync(path.join(extractDir, "file2.txt"))).toBe(true);

      fs.rmSync(extractDir, { recursive: true, force: true });
    });

    it("should handle empty directory", async () => {
      const archive = await createArchive(tempDir, []);

      expect(archive).toBeInstanceOf(Buffer);
      expect(archive.length).toBeGreaterThan(0);
    });

    it("should preserve nested directory structure", async () => {
      fs.mkdirSync(path.join(tempDir, "subdir"));
      fs.writeFileSync(path.join(tempDir, "subdir", "nested.txt"), "nested");

      const files = await getAllFiles(tempDir);
      const archive = await createArchive(tempDir, files);

      const extractDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "extract-test-"),
      );
      const archivePath = path.join(extractDir, "test.tar.gz");
      fs.writeFileSync(archivePath, archive);

      await tar.extract({
        file: archivePath,
        cwd: extractDir,
      });

      expect(fs.existsSync(path.join(extractDir, "subdir", "nested.txt"))).toBe(
        true,
      );

      fs.rmSync(extractDir, { recursive: true, force: true });
    });
  });

  describe("createManifest", () => {
    it("should create valid JSON manifest", () => {
      const files: FileEntryWithHash[] = [
        { path: "test.txt", hash: "abc123", size: 100 },
      ];

      const manifest = createManifest(files);
      const parsed = JSON.parse(manifest.toString());

      expect(parsed.version).toBe(1);
      expect(parsed.files).toEqual(files);
      expect(parsed.createdAt).toBeDefined();
    });

    it("should include all file entries", () => {
      const files: FileEntryWithHash[] = [
        { path: "a.txt", hash: "hash1", size: 10 },
        { path: "b.txt", hash: "hash2", size: 20 },
        { path: "c.txt", hash: "hash3", size: 30 },
      ];

      const manifest = createManifest(files);
      const parsed = JSON.parse(manifest.toString());

      expect(parsed.files).toHaveLength(3);
      expect(parsed.files[0].path).toBe("a.txt");
      expect(parsed.files[1].path).toBe("b.txt");
      expect(parsed.files[2].path).toBe("c.txt");
    });

    it("should handle empty file list", () => {
      const manifest = createManifest([]);
      const parsed = JSON.parse(manifest.toString());

      expect(parsed.version).toBe(1);
      expect(parsed.files).toEqual([]);
    });

    it("should return Buffer", () => {
      const manifest = createManifest([]);

      expect(manifest).toBeInstanceOf(Buffer);
    });

    it("should produce pretty-printed JSON", () => {
      const files: FileEntryWithHash[] = [
        { path: "test.txt", hash: "abc", size: 1 },
      ];

      const manifest = createManifest(files);
      const content = manifest.toString();

      // Should have newlines (pretty-printed)
      expect(content).toContain("\n");
    });
  });
});
