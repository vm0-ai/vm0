/**
 * Unit tests for checkpoint module.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { findCodexSessionFile } from "../checkpoint";

describe("findCodexSessionFile", () => {
  let testDir: string;

  beforeEach(() => {
    // Create temp directory for tests
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
  });

  afterEach(() => {
    // Cleanup test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should return null for non-existent directory", () => {
    const result = findCodexSessionFile("/nonexistent", "session-123");
    expect(result).toBe(null);
  });

  it("should return null for empty directory", () => {
    const result = findCodexSessionFile(testDir, "session-123");
    expect(result).toBe(null);
  });

  it("should find session file by exact ID match in filename", () => {
    // Create nested structure like Codex
    const dateDir = path.join(testDir, "2025", "01", "10");
    fs.mkdirSync(dateDir, { recursive: true });

    const sessionFile = path.join(
      dateDir,
      "rollout-2025-01-10T08-04-44-019b3aca-2df2-7573-8f88-4240b7bc350a.jsonl",
    );
    fs.writeFileSync(sessionFile, '{"type":"test"}');

    const result = findCodexSessionFile(
      testDir,
      "019b3aca-2df2-7573-8f88-4240b7bc350a",
    );
    expect(result).toBe(sessionFile);
  });

  it("should find session file with dashes removed", () => {
    const dateDir = path.join(testDir, "2025", "01", "10");
    fs.mkdirSync(dateDir, { recursive: true });

    const sessionFile = path.join(dateDir, "rollout-abc123def456.jsonl");
    fs.writeFileSync(sessionFile, '{"type":"test"}');

    // Search with dashes (should match after removing dashes)
    const result = findCodexSessionFile(testDir, "abc-123-def-456");
    expect(result).toBe(sessionFile);
  });

  it("should return most recent file when ID not found", () => {
    const dateDir = path.join(testDir, "2025", "01", "10");
    fs.mkdirSync(dateDir, { recursive: true });

    // Create older file
    const olderFile = path.join(dateDir, "rollout-old.jsonl");
    fs.writeFileSync(olderFile, '{"type":"old"}');

    // Wait and create newer file
    const newerFile = path.join(dateDir, "rollout-new.jsonl");
    // Touch with a future time to ensure it's newer
    fs.writeFileSync(newerFile, '{"type":"new"}');
    const futureTime = Date.now() + 10000;
    fs.utimesSync(newerFile, futureTime / 1000, futureTime / 1000);

    const result = findCodexSessionFile(testDir, "nonexistent-id");
    expect(result).toBe(newerFile);
  });

  it("should search recursively through date directories", () => {
    // Create multiple date directories
    const dir1 = path.join(testDir, "2025", "01", "09");
    const dir2 = path.join(testDir, "2025", "01", "10");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const file1 = path.join(dir1, "rollout-session-aaa.jsonl");
    const file2 = path.join(dir2, "rollout-session-bbb.jsonl");
    fs.writeFileSync(file1, '{"type":"test1"}');
    fs.writeFileSync(file2, '{"type":"test2"}');

    // Should find file in nested directory
    const result = findCodexSessionFile(testDir, "session-bbb");
    expect(result).toBe(file2);
  });

  it("should only match jsonl files", () => {
    const dateDir = path.join(testDir, "2025", "01", "10");
    fs.mkdirSync(dateDir, { recursive: true });

    // Create non-jsonl file with matching name
    const txtFile = path.join(dateDir, "rollout-mysession.txt");
    fs.writeFileSync(txtFile, "test");

    // Create jsonl file with different ID
    const jsonlFile = path.join(dateDir, "rollout-othersession.jsonl");
    fs.writeFileSync(jsonlFile, '{"type":"test"}');

    // Search for ID that matches txt file - should not find it
    const result = findCodexSessionFile(testDir, "mysession");
    // Should return the only jsonl file as fallback
    expect(result).toBe(jsonlFile);
  });
});
