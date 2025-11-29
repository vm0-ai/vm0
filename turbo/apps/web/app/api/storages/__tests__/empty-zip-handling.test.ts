/**
 * @vitest-environment node
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import AdmZip from "adm-zip";

/**
 * Tests for empty zip handling behavior.
 *
 * This tests the key fix in the storages API route:
 * - AdmZip.extractAllTo() does NOT create the target directory for empty zips
 * - We must ensure the directory exists before/after extraction
 */
describe("Empty Zip Handling", () => {
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

  it("AdmZip does NOT create directory for empty zip extraction", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-empty-zip-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create empty zip
    const zip = new AdmZip();
    const zipPath = path.join(tempDir, "empty.zip");
    zip.writeZip(zipPath);

    // Extract empty zip
    const extractPath = path.join(tempDir, "extracted");
    const zip2 = new AdmZip(zipPath);
    zip2.extractAllTo(extractPath, true);

    // Verify: directory should NOT exist (this is the problematic behavior we're working around)
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(false);
  });

  it("mkdir after extraction ensures directory exists for empty zip", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-empty-zip-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create empty zip
    const zip = new AdmZip();
    const zipPath = path.join(tempDir, "empty.zip");
    zip.writeZip(zipPath);

    // Extract empty zip (directory won't be created)
    const extractPath = path.join(tempDir, "extracted");
    const zip2 = new AdmZip(zipPath);
    zip2.extractAllTo(extractPath, true);

    // Apply fix: ensure directory exists
    await fs.promises.mkdir(extractPath, { recursive: true });

    // Verify: directory should now exist
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);

    // Verify: directory should be empty
    const files = await fs.promises.readdir(extractPath);
    expect(files).toHaveLength(0);
  });

  it("mkdir before extraction also works (our implementation)", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-empty-zip-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create empty zip
    const zip = new AdmZip();
    const zipPath = path.join(tempDir, "empty.zip");
    zip.writeZip(zipPath);

    // This is how we implement it in route.ts:
    // 1. Create extract directory first
    // 2. Then extract (which does nothing for empty zip, but directory exists)
    const extractPath = path.join(tempDir, "extracted");
    await fs.promises.mkdir(extractPath, { recursive: true });

    const zip2 = new AdmZip(zipPath);
    zip2.extractAllTo(extractPath, true);

    // Verify: directory should exist
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);

    // Verify: directory should be empty
    const files = await fs.promises.readdir(extractPath);
    expect(files).toHaveLength(0);
  });

  it("non-empty zip extraction creates directory automatically", async () => {
    // Create temp directory
    const tempDir = path.join(os.tmpdir(), `test-nonempty-zip-${Date.now()}`);
    tempDirs.push(tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create zip with a file
    const zip = new AdmZip();
    zip.addFile("test.txt", Buffer.from("hello world"));
    const zipPath = path.join(tempDir, "nonempty.zip");
    zip.writeZip(zipPath);

    // Extract non-empty zip
    const extractPath = path.join(tempDir, "extracted");
    const zip2 = new AdmZip(zipPath);
    zip2.extractAllTo(extractPath, true);

    // Verify: directory should exist (created by AdmZip for non-empty zip)
    const exists = fs.existsSync(extractPath);
    expect(exists).toBe(true);

    // Verify: should contain the file
    const files = await fs.promises.readdir(extractPath);
    expect(files).toContain("test.txt");
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
