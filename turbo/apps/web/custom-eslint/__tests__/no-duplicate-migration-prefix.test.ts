import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { findDuplicatePrefixes } from "../rules/no-duplicate-migration-prefix.ts";

describe("findDuplicatePrefixes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("should return empty array when no duplicates exist", () => {
    fs.writeFileSync(path.join(tempDir, "0001_first.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0002_second.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0003_third.sql"), "");

    const result = findDuplicatePrefixes(tempDir);
    expect(result).toEqual([]);
  });

  it("should detect duplicate prefixes", () => {
    fs.writeFileSync(path.join(tempDir, "0001_first.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0001_duplicate.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0002_second.sql"), "");

    const result = findDuplicatePrefixes(tempDir);
    expect(result).toEqual([
      { prefix: "0001", files: ["0001_duplicate.sql", "0001_first.sql"] },
    ]);
  });

  it("should detect multiple duplicate prefixes", () => {
    fs.writeFileSync(path.join(tempDir, "0001_a.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0001_b.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0002_a.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0002_b.sql"), "");

    const result = findDuplicatePrefixes(tempDir);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      prefix: "0001",
      files: ["0001_a.sql", "0001_b.sql"],
    });
    expect(result).toContainEqual({
      prefix: "0002",
      files: ["0002_a.sql", "0002_b.sql"],
    });
  });

  it("should return empty array for non-existent directory", () => {
    const result = findDuplicatePrefixes("/non/existent/path");
    expect(result).toEqual([]);
  });

  it("should ignore non-migration files", () => {
    fs.writeFileSync(path.join(tempDir, "0001_first.sql"), "");
    fs.writeFileSync(path.join(tempDir, "_journal.json"), "{}");
    fs.writeFileSync(path.join(tempDir, "README.md"), "");
    fs.writeFileSync(path.join(tempDir, "0001.sql"), ""); // Missing underscore

    const result = findDuplicatePrefixes(tempDir);
    expect(result).toEqual([]);
  });

  it("should handle files with similar but different prefixes", () => {
    fs.writeFileSync(path.join(tempDir, "0001_first.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0010_tenth.sql"), "");
    fs.writeFileSync(path.join(tempDir, "0100_hundredth.sql"), "");

    const result = findDuplicatePrefixes(tempDir);
    expect(result).toEqual([]);
  });
});
