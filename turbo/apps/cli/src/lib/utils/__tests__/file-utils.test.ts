/**
 * Tests for file-utils helper functions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { checkDirectoryStatus } from "../file-utils";

describe("checkDirectoryStatus", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-utils-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return exists=false for non-existent path", () => {
    const nonExistent = path.join(tempDir, "does-not-exist");
    const result = checkDirectoryStatus(nonExistent);

    expect(result).toEqual({ exists: false, empty: true });
  });

  it("should return exists=true, empty=true for empty directory", () => {
    const emptyDir = path.join(tempDir, "empty-dir");
    fs.mkdirSync(emptyDir);

    const result = checkDirectoryStatus(emptyDir);

    expect(result).toEqual({ exists: true, empty: true });
  });

  it("should return exists=true, empty=false for non-empty directory", () => {
    const nonEmptyDir = path.join(tempDir, "non-empty-dir");
    fs.mkdirSync(nonEmptyDir);
    fs.writeFileSync(path.join(nonEmptyDir, "file.txt"), "content");

    const result = checkDirectoryStatus(nonEmptyDir);

    expect(result).toEqual({ exists: true, empty: false });
  });

  it("should return exists=true, empty=false for directory with subdirectory", () => {
    const dirWithSubdir = path.join(tempDir, "dir-with-subdir");
    fs.mkdirSync(dirWithSubdir);
    fs.mkdirSync(path.join(dirWithSubdir, "subdir"));

    const result = checkDirectoryStatus(dirWithSubdir);

    expect(result).toEqual({ exists: true, empty: false });
  });

  it("should return exists=true, empty=false for file (not directory)", () => {
    const filePath = path.join(tempDir, "file.txt");
    fs.writeFileSync(filePath, "content");

    const result = checkDirectoryStatus(filePath);

    expect(result).toEqual({ exists: true, empty: false });
  });

  it("should return exists=true, empty=false for directory with hidden file", () => {
    const dirWithHidden = path.join(tempDir, "dir-with-hidden");
    fs.mkdirSync(dirWithHidden);
    fs.writeFileSync(path.join(dirWithHidden, ".hidden"), "content");

    const result = checkDirectoryStatus(dirWithHidden);

    expect(result).toEqual({ exists: true, empty: false });
  });
});
