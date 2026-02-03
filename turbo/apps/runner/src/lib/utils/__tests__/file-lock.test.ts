import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "../file-lock.js";

describe("withFileLock", () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-lock-test-"));
    testFile = path.join(testDir, "test.txt");
    fs.writeFileSync(testFile, "test content");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should execute function and return result", async () => {
    const result = await withFileLock(testFile, async () => {
      return "success";
    });

    expect(result).toBe("success");
  });

  it("should release lock after function completes", async () => {
    await withFileLock(testFile, async () => {
      // Lock is held here
    });

    // Lock should be released - should be able to acquire again
    const result = await withFileLock(testFile, async () => "second");
    expect(result).toBe("second");
  });

  it("should release lock even if function throws", async () => {
    await expect(
      withFileLock(testFile, async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");

    // Lock should be released - should be able to acquire again
    const result = await withFileLock(testFile, async () => "recovered");
    expect(result).toBe("recovered");
  });

  it("should handle concurrent access", async () => {
    let counter = 0;
    const operations = Array.from({ length: 5 }, () =>
      withFileLock(testFile, async () => {
        const current = counter;
        await new Promise((r) => setTimeout(r, 10));
        counter = current + 1;
        return counter;
      }),
    );

    await Promise.all(operations);

    // With proper locking, counter should reach 5
    expect(counter).toBe(5);
  });
});
