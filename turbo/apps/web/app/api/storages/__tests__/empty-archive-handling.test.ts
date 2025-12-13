/**
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as tar from "tar";

/**
 * Tests for empty tar.gz archive handling behavior.
 *
 * This tests the key behavior in the storages API route:
 * - tar.extract() does NOT create the target directory for empty archives
 * - We must ensure the directory exists before extraction
 */
describe("Empty Archive Handling", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    // Cleanup temp directories
    for (const dir of tempDirs) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {
        // Ignore cleanup errors
      });
    }
    tempDirs.length = 0;
  });

  it("tar.extract needs directory to exist for empty archives", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-empty-tar-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create empty tar.gz by creating an empty directory and tarring it
    const emptyDir = path.join(tempDir, "empty-source");
    await fs.promises.mkdir(emptyDir, { recursive: true });

    const tarPath = path.join(tempDir, "empty.tar.gz");
    await tar.create(
      {
        gzip: true,
        file: tarPath,
        cwd: emptyDir,
      },
      ["."],
    );

    // Extract empty tar - directory must exist first
    const extractPath = path.join(tempDir, "extracted");
    await fs.promises.mkdir(extractPath, { recursive: true });

    await tar.extract({
      file: tarPath,
      cwd: extractPath,
      gzip: true,
    });

    // Verify: directory should exist
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);

    // Verify: directory should be empty (only has "." entry which is not a file)
    const files = await fs.promises.readdir(extractPath);
    expect(files).toHaveLength(0);
  });

  it("non-empty tar.gz extraction works correctly", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-nonempty-tar-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create directory with a file
    const sourceDir = path.join(tempDir, "source");
    await fs.promises.mkdir(sourceDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sourceDir, "test.txt"),
      "hello world",
    );

    // Create tar.gz
    const tarPath = path.join(tempDir, "nonempty.tar.gz");
    await tar.create(
      {
        gzip: true,
        file: tarPath,
        cwd: sourceDir,
      },
      ["test.txt"],
    );

    // Extract non-empty tar
    const extractPath = path.join(tempDir, "extracted");
    await fs.promises.mkdir(extractPath, { recursive: true });

    await tar.extract({
      file: tarPath,
      cwd: extractPath,
      gzip: true,
    });

    // Verify: directory should exist
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);

    // Verify: should contain the file
    const files = await fs.promises.readdir(extractPath);
    expect(files).toContain("test.txt");

    // Verify: file content is correct
    const content = await fs.promises.readFile(
      path.join(extractPath, "test.txt"),
      "utf-8",
    );
    expect(content).toBe("hello world");
  });

  it("mkdir with recursive:true is idempotent (safe to call multiple times)", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-mkdir-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const extractPath = path.join(tempDir, "extracted");

    // Call mkdir multiple times - should not throw
    await fs.promises.mkdir(extractPath, { recursive: true });
    await fs.promises.mkdir(extractPath, { recursive: true });
    await fs.promises.mkdir(extractPath, { recursive: true });

    // Directory should exist
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);
  });

  it("Python tarfile empty archive throws TAR_BAD_ARCHIVE error", async () => {
    // Python's tarfile.open("w:gz") with no files added creates a ~67-byte archive
    // that Node.js tar library cannot read. This is the exact bytes Python produces:
    // Created by: python3 -c "import tarfile; tarfile.open('/tmp/empty.tar.gz', 'w:gz').close()"
    const pythonEmptyTarGz = Buffer.from([
      0x1f, 0x8b, 0x08, 0x08, 0x5d, 0x8e, 0x3d, 0x69, 0x02, 0xff, 0x72, 0x65,
      0x61, 0x6c, 0x2d, 0x70, 0x79, 0x74, 0x68, 0x6f, 0x6e, 0x2d, 0x65, 0x6d,
      0x70, 0x74, 0x79, 0x2e, 0x74, 0x61, 0x72, 0x00, 0xed, 0xc1, 0x01, 0x0d,
      0x00, 0x00, 0x00, 0xc2, 0xa0, 0xf7, 0x4f, 0x6d, 0x0e, 0x37, 0xa0, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x37, 0x03, 0x9a,
      0xde, 0x1d, 0x27, 0x00, 0x28, 0x00, 0x00,
    ]);

    const tempDir = path.join(os.tmpdir(), `test-python-tar-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const tarPath = path.join(tempDir, "python-empty.tar.gz");
    await fs.promises.writeFile(tarPath, pythonEmptyTarGz);

    const extractPath = path.join(tempDir, "extracted");
    await fs.promises.mkdir(extractPath, { recursive: true });

    // Node.js tar should throw TAR_BAD_ARCHIVE error
    await expect(
      tar.extract({
        file: tarPath,
        cwd: extractPath,
        gzip: true,
      }),
    ).rejects.toThrow("TAR_BAD_ARCHIVE");
  });

  it("TAR_BAD_ARCHIVE can be caught and handled gracefully", async () => {
    // This tests the error handling pattern used in the storage webhooks
    const pythonEmptyTarGz = Buffer.from([
      0x1f, 0x8b, 0x08, 0x08, 0x5d, 0x8e, 0x3d, 0x69, 0x02, 0xff, 0x72, 0x65,
      0x61, 0x6c, 0x2d, 0x70, 0x79, 0x74, 0x68, 0x6f, 0x6e, 0x2d, 0x65, 0x6d,
      0x70, 0x74, 0x79, 0x2e, 0x74, 0x61, 0x72, 0x00, 0xed, 0xc1, 0x01, 0x0d,
      0x00, 0x00, 0x00, 0xc2, 0xa0, 0xf7, 0x4f, 0x6d, 0x0e, 0x37, 0xa0, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x37, 0x03, 0x9a,
      0xde, 0x1d, 0x27, 0x00, 0x28, 0x00, 0x00,
    ]);

    const tempDir = path.join(os.tmpdir(), `test-graceful-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    const tarPath = path.join(tempDir, "python-empty.tar.gz");
    await fs.promises.writeFile(tarPath, pythonEmptyTarGz);

    const extractPath = path.join(tempDir, "extracted");
    await fs.promises.mkdir(extractPath, { recursive: true });

    // Simulate the error handling in storage webhooks
    let handledAsEmpty = false;
    try {
      await tar.extract({
        file: tarPath,
        cwd: extractPath,
        gzip: true,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("TAR_BAD_ARCHIVE")) {
        handledAsEmpty = true;
        // extractPath is already created and empty, continue with 0 files
      } else {
        throw error;
      }
    }

    expect(handledAsEmpty).toBe(true);
    expect(fs.existsSync(extractPath)).toBe(true);
    const files = await fs.promises.readdir(extractPath);
    expect(files).toHaveLength(0);
  });
});
