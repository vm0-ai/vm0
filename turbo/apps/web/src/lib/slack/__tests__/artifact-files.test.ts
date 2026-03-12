import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect } from "vitest";
import { diffManifests, extractFilesFromArchive } from "../artifact-files";
import type { S3StorageManifest } from "../../s3/types";

function makeManifest(
  files: Array<{ path: string; hash: string; size: number }>,
): S3StorageManifest {
  return {
    version: "test-version",
    createdAt: new Date().toISOString(),
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    fileCount: files.length,
    files,
  };
}

describe("diffManifests", () => {
  it("should detect new files when previous manifest is null (first run)", () => {
    const current = makeManifest([
      { path: "report.pdf", hash: "aaa", size: 100 },
      { path: "data.csv", hash: "bbb", size: 200 },
    ]);

    const result = diffManifests(current, null);

    expect(result).toEqual(["report.pdf", "data.csv"]);
  });

  it("should detect new files not present in previous manifest", () => {
    const previous = makeManifest([
      { path: "existing.txt", hash: "aaa", size: 100 },
    ]);
    const current = makeManifest([
      { path: "existing.txt", hash: "aaa", size: 100 },
      { path: "new-file.pdf", hash: "bbb", size: 200 },
    ]);

    const result = diffManifests(current, previous);

    expect(result).toEqual(["new-file.pdf"]);
  });

  it("should detect changed files with different hashes", () => {
    const previous = makeManifest([
      { path: "report.pdf", hash: "old-hash", size: 100 },
    ]);
    const current = makeManifest([
      { path: "report.pdf", hash: "new-hash", size: 150 },
    ]);

    const result = diffManifests(current, previous);

    expect(result).toEqual(["report.pdf"]);
  });

  it("should return empty array when nothing changed", () => {
    const manifest = makeManifest([
      { path: "file.txt", hash: "aaa", size: 100 },
    ]);

    const result = diffManifests(manifest, manifest);

    expect(result).toEqual([]);
  });

  it("should not include deleted files (only in previous, not current)", () => {
    const previous = makeManifest([
      { path: "deleted.txt", hash: "aaa", size: 100 },
      { path: "kept.txt", hash: "bbb", size: 200 },
    ]);
    const current = makeManifest([
      { path: "kept.txt", hash: "bbb", size: 200 },
    ]);

    const result = diffManifests(current, previous);

    expect(result).toEqual([]);
  });
});

describe("extractFilesFromArchive", () => {
  it("should extract only targeted files from archive", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tar-test-"));
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir);

    fs.writeFileSync(path.join(srcDir, "report.pdf"), "PDF content here");
    fs.writeFileSync(path.join(srcDir, "data.csv"), "a,b,c\n1,2,3");
    fs.writeFileSync(path.join(srcDir, "ignored.py"), "print('hello')");

    const archivePath = path.join(tmpDir, "archive.tar.gz");
    execSync(`tar -czf ${archivePath} -C ${srcDir} .`);
    const archiveBuffer = fs.readFileSync(archivePath);

    // Clean up
    fs.rmSync(tmpDir, { recursive: true });

    const result = await extractFilesFromArchive(
      archiveBuffer,
      new Set(["./report.pdf", "./data.csv"]),
    );

    expect(result).toHaveLength(2);
    const filenames = result.map((f) => f.filename).sort();
    expect(filenames).toEqual(["data.csv", "report.pdf"]);
    expect(
      result.find((f) => f.filename === "report.pdf")?.content.toString(),
    ).toBe("PDF content here");
    expect(
      result.find((f) => f.filename === "data.csv")?.content.toString(),
    ).toBe("a,b,c\n1,2,3");
  });

  it("should return empty array when no files match", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tar-test-"));
    const srcDir = path.join(tmpDir, "src");
    fs.mkdirSync(srcDir);

    fs.writeFileSync(path.join(srcDir, "only-file.txt"), "content");

    const archivePath = path.join(tmpDir, "archive.tar.gz");
    execSync(`tar -czf ${archivePath} -C ${srcDir} .`);
    const archiveBuffer = fs.readFileSync(archivePath);

    fs.rmSync(tmpDir, { recursive: true });

    const result = await extractFilesFromArchive(
      archiveBuffer,
      new Set(["nonexistent.pdf"]),
    );

    expect(result).toHaveLength(0);
  });
});
