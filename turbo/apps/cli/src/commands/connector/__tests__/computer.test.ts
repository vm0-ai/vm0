import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  writePid,
  readPid,
  deletePid,
  getLogPath,
} from "../lib/computer/pid-manager";

const TEST_PID_DIR = join(
  homedir(),
  ".config",
  "vm0",
  "computer-connector",
  "pids",
);

describe("computer connector - PID management", () => {
  beforeEach(async () => {
    await mkdir(TEST_PID_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_PID_DIR, { recursive: true, force: true });
  });

  it("should write and read PID file", async () => {
    await writePid("test-service", 12345);

    const pid = await readPid("test-service");
    expect(pid).toBe(12345);
  });

  it("should delete PID file", async () => {
    await writePid("test-service", 12345);
    await deletePid("test-service");

    await expect(readPid("test-service")).rejects.toThrow();
  });

  it("should return correct log path", () => {
    const logPath = getLogPath("test-service");
    expect(logPath).toContain("test-service.log");
    expect(logPath).toContain(".config/vm0/computer-connector/pids");
  });

  it("should handle invalid PID content", async () => {
    const pidFile = join(TEST_PID_DIR, "invalid.pid");
    await rm(pidFile, { force: true });
    await mkdir(TEST_PID_DIR, { recursive: true });
    const { writeFile } = await import("fs/promises");
    await writeFile(pidFile, "not-a-number", "utf-8");

    const pid = await readPid("invalid");
    expect(pid).toBeNull();
  });
});

describe("computer connector - ngrok integration", () => {
  it("should call ngrok.forward with correct parameters", async () => {
    // Mock @ngrok/ngrok module
    const mockForward = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@ngrok/ngrok", () => ({
      default: {
        forward: mockForward,
      },
    }));

    const { startNgrokTunnel } = await import("../lib/computer/ngrok");

    await startNgrokTunnel("test-token", "test-prefix");

    expect(mockForward).toHaveBeenCalledWith({
      addr: "localhost:8888",
      authtoken: "test-token",
      domain: "webdav.test-prefix.internal",
    });
  });
});
