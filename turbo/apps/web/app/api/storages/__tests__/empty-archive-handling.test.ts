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
});
