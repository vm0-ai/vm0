import { describe, it, expect } from "vitest";
import * as zlib from "zlib";
import * as tarStream from "tar";
import { Readable } from "stream";
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
  async function createTarGz(
    files: Array<{ path: string; content: string }>,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const pack = new tarStream.Pack();
      const chunks: Buffer[] = [];

      for (const file of files) {
        const buf = Buffer.from(file.content, "utf-8");
        pack.write(
          new tarStream.ReadEntry(
            new tarStream.Header({
              path: file.path,
              size: buf.length,
              type: "File",
            }),
            undefined,
            { maxReadSize: buf.length },
          ),
        );
      }

      // Use tar.create with gzip to build the archive properly
      // For testing, we'll build the archive manually
      const gzip = zlib.createGzip();
      const passthrough: Buffer[] = [];

      gzip.on("data", (chunk: Buffer) => passthrough.push(chunk));
      gzip.on("end", () => resolve(Buffer.concat(passthrough)));
      gzip.on("error", reject);

      pack.on("error", reject);
      pack.pipe(gzip);

      for (const file of files) {
        const buf = Buffer.from(file.content, "utf-8");
        pack.add(Readable.from(buf), {
          path: file.path,
          size: buf.length,
          type: "File",
        } as tarStream.HeaderData);
      }

      pack.end();
    });
  }

  it("should extract only targeted files from archive", async () => {
    // Create a real tar.gz with known contents using shell
    const { execSync } = await import("child_process");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

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
    const { execSync } = await import("child_process");
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

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
