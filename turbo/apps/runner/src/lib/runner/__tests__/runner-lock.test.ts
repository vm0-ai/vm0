import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { exec } from "node:child_process";
import { acquireRunnerLock, releaseRunnerLock } from "../runner-lock.js";

// Mock modules
vi.mock("node:fs");
vi.mock("node:child_process");

describe("runner-lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: directory exists, no PID file
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      if (path === "/var/run/vm0") return true;
      return false;
    });

    // Mock exec for sudo commands - use type assertion to handle complex overloads
    vi.mocked(exec).mockImplementation(((_cmd, _options, callback) => {
      const cb =
        typeof _options === "function"
          ? (_options as (error: Error | null) => void)
          : (callback as ((error: Error | null) => void) | undefined);
      if (cb) cb(null);
      return {} as ReturnType<typeof exec>;
    }) as typeof exec);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("acquireRunnerLock", () => {
    it("should create PID file with current PID", async () => {
      await acquireRunnerLock();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        "/var/run/vm0/runner.pid",
        process.pid.toString(),
      );
    });

    it("should clean up stale PID file from non-existent process", async () => {
      // PID file exists with stale PID
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === "/var/run/vm0") return true;
        if (path === "/var/run/vm0/runner.pid") return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue("999999999");

      // Mock process.kill to throw (process doesn't exist)
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw new Error("ESRCH");
      });

      await acquireRunnerLock();

      // Should have tried to check if process exists
      expect(killSpy).toHaveBeenCalledWith(999999999, 0);
      // Should have removed stale file
      expect(fs.unlinkSync).toHaveBeenCalledWith("/var/run/vm0/runner.pid");
      // Should have written new PID
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        "/var/run/vm0/runner.pid",
        process.pid.toString(),
      );

      killSpy.mockRestore();
    });

    it("should exit if another runner is running", async () => {
      // PID file exists with running process
      const runningPid = 12345;
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === "/var/run/vm0") return true;
        if (path === "/var/run/vm0/runner.pid") return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(runningPid.toString());

      // Mock process.kill to succeed (process exists)
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await acquireRunnerLock();

      expect(killSpy).toHaveBeenCalledWith(runningPid, 0);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Another runner is already running"),
      );

      killSpy.mockRestore();
    });

    it("should exit if process exists but we lack permission (EPERM)", async () => {
      // PID file exists with process owned by another user
      const runningPid = 1; // init/systemd - typically can't signal
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        if (path === "/var/run/vm0") return true;
        if (path === "/var/run/vm0/runner.pid") return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(runningPid.toString());

      // Mock process.kill to throw EPERM (process exists but no permission)
      const epermError = new Error("EPERM") as Error & { code: string };
      epermError.code = "EPERM";
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
        throw epermError;
      });
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      await acquireRunnerLock();

      // EPERM means process exists, so should exit
      expect(killSpy).toHaveBeenCalledWith(runningPid, 0);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Another runner is already running"),
      );

      killSpy.mockRestore();
    });
  });

  describe("releaseRunnerLock", () => {
    it("should remove PID file", () => {
      // PID file exists
      vi.mocked(fs.existsSync).mockReturnValue(true);

      releaseRunnerLock();

      expect(fs.unlinkSync).toHaveBeenCalledWith("/var/run/vm0/runner.pid");
    });

    it("should not throw if PID file does not exist", () => {
      // PID file doesn't exist
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(() => releaseRunnerLock()).not.toThrow();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });
  });
});
