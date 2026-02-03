import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireRunnerLock, releaseRunnerLock } from "../runner-lock.js";

describe("runner-lock", () => {
  let testDir: string;
  let pidFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create temp directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-lock-test-"));
    pidFile = path.join(testDir, "runner.pid");
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("acquireRunnerLock", () => {
    it("should create PID file with current PID", () => {
      acquireRunnerLock({ pidFile });

      expect(fs.existsSync(pidFile)).toBe(true);
      const content = fs.readFileSync(pidFile, "utf-8");
      expect(content).toBe(process.pid.toString());

      releaseRunnerLock();
    });

    it("should clean up stale PID file from non-existent process", () => {
      // Write a fake PID that doesn't exist (very high number)
      fs.writeFileSync(pidFile, "999999999");

      acquireRunnerLock({ pidFile });

      // Should have replaced with current PID
      const content = fs.readFileSync(pidFile, "utf-8");
      expect(content).toBe(process.pid.toString());

      releaseRunnerLock();
    });

    it("should clean up invalid PID file with non-numeric content", () => {
      // Write invalid content
      fs.writeFileSync(pidFile, "not-a-number");

      acquireRunnerLock({ pidFile });

      // Should have replaced with current PID
      const content = fs.readFileSync(pidFile, "utf-8");
      expect(content).toBe(process.pid.toString());

      releaseRunnerLock();
    });

    it("should exit if another runner is running", () => {
      // Write current process's parent PID (known to be running)
      const parentPid = process.ppid;
      fs.writeFileSync(pidFile, parentPid.toString());

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      acquireRunnerLock({ pidFile });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Another runner is already running"),
      );

      // Clean up manually since lock was not acquired
      fs.unlinkSync(pidFile);
    });

    it("should exit if process exists but we lack permission (EPERM)", () => {
      // Write PID 1 (init/systemd - typically can't signal)
      fs.writeFileSync(pidFile, "1");

      // Mock process.kill to throw EPERM
      const epermError = new Error("EPERM") as Error & { code: string };
      epermError.code = "EPERM";
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw epermError;
      });
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      vi.spyOn(console, "error").mockImplementation(() => undefined);

      acquireRunnerLock({ pidFile });

      // EPERM means process exists, so should exit
      expect(exitSpy).toHaveBeenCalledWith(1);

      killSpy.mockRestore();
      fs.unlinkSync(pidFile);
    });
  });

  describe("releaseRunnerLock", () => {
    it("should remove PID file", () => {
      acquireRunnerLock({ pidFile });
      expect(fs.existsSync(pidFile)).toBe(true);

      releaseRunnerLock();
      expect(fs.existsSync(pidFile)).toBe(false);
    });

    it("should not throw if PID file does not exist", () => {
      // PID file doesn't exist
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(() => releaseRunnerLock()).not.toThrow();
    });
  });
});
