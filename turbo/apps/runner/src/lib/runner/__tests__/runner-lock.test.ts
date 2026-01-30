import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { acquireRunnerLock, releaseRunnerLock } from "../runner-lock.js";

const PID_FILE = "/var/run/vm0/runner.pid";

describe("runner-lock", () => {
  afterEach(() => {
    // Clean up PID file after each test
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    vi.restoreAllMocks();
  });

  describe("acquireRunnerLock", () => {
    it("should create PID file with current PID", async () => {
      await acquireRunnerLock();

      expect(fs.existsSync(PID_FILE)).toBe(true);
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"), 10);
      expect(pid).toBe(process.pid);

      releaseRunnerLock();
    });

    it("should clean up stale PID file from non-existent process", async () => {
      // Write a fake PID that doesn't exist (very high number)
      fs.writeFileSync(PID_FILE, "999999999");

      await acquireRunnerLock();

      // Should have replaced with current PID
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8"), 10);
      expect(pid).toBe(process.pid);

      releaseRunnerLock();
    });

    it("should exit if another runner is running", async () => {
      // Write current process PID (simulating another runner)
      // We use a different approach - write PID of a known running process
      const parentPid = process.ppid;
      fs.writeFileSync(PID_FILE, parentPid.toString());

      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await acquireRunnerLock();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Another runner is already running"),
      );

      // Clean up
      fs.unlinkSync(PID_FILE);
    });
  });

  describe("releaseRunnerLock", () => {
    it("should remove PID file", async () => {
      await acquireRunnerLock();
      expect(fs.existsSync(PID_FILE)).toBe(true);

      releaseRunnerLock();
      expect(fs.existsSync(PID_FILE)).toBe(false);
    });

    it("should not throw if PID file does not exist", () => {
      // Should not throw
      expect(() => releaseRunnerLock()).not.toThrow();
    });
  });
});
