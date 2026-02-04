import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "node:child_process";

// Mock child_process module
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Import after mocking
import { killProcessTree, isProcessRunning } from "../process.js";

describe("isProcessRunning", () => {
  const originalKill = process.kill;

  afterEach(() => {
    process.kill = originalKill;
  });

  it("should return true when process exists", () => {
    process.kill = vi.fn();

    expect(isProcessRunning(1234)).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(1234, 0);
  });

  it("should return true when EPERM (process exists but no permission)", () => {
    const epermError = new Error("EPERM") as NodeJS.ErrnoException;
    epermError.code = "EPERM";
    process.kill = vi.fn().mockImplementation(() => {
      throw epermError;
    });

    expect(isProcessRunning(1234)).toBe(true);
  });

  it("should return false when ESRCH (no such process)", () => {
    const esrchError = new Error("ESRCH") as NodeJS.ErrnoException;
    esrchError.code = "ESRCH";
    process.kill = vi.fn().mockImplementation(() => {
      throw esrchError;
    });

    expect(isProcessRunning(1234)).toBe(false);
  });

  it("should return false for other errors", () => {
    process.kill = vi.fn().mockImplementation(() => {
      throw new Error("Unknown error");
    });

    expect(isProcessRunning(1234)).toBe(false);
  });
});

describe("killProcessTree", () => {
  const originalKill = process.kill;
  const mockedExecSync = vi.mocked(childProcess.execSync);

  beforeEach(() => {
    vi.clearAllMocks();
    process.kill = vi.fn();
  });

  afterEach(() => {
    process.kill = originalKill;
  });

  it("should kill process with no children", () => {
    mockedExecSync.mockReturnValue("");

    killProcessTree(1000);

    expect(mockedExecSync).toHaveBeenCalledWith(
      "pgrep -P 1000 2>/dev/null || true",
      { encoding: "utf-8" },
    );
    expect(process.kill).toHaveBeenCalledWith(1000, "SIGKILL");
  });

  it("should kill children before parent (depth-first)", () => {
    const killOrder: number[] = [];
    process.kill = vi.fn().mockImplementation((pid: number) => {
      killOrder.push(pid);
    });

    // Parent 1000 has child 2000
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("pgrep -P 1000")) return "2000\n";
      if (cmd.includes("pgrep -P 2000")) return "";
      return "";
    });

    killProcessTree(1000);

    // Child should be killed before parent
    expect(killOrder).toEqual([2000, 1000]);
  });

  it("should handle multiple children", () => {
    const killOrder: number[] = [];
    process.kill = vi.fn().mockImplementation((pid: number) => {
      killOrder.push(pid);
    });

    // Parent 1000 has children 2000, 3000
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("pgrep -P 1000")) return "2000\n3000\n";
      if (cmd.includes("pgrep -P 2000")) return "";
      if (cmd.includes("pgrep -P 3000")) return "";
      return "";
    });

    killProcessTree(1000);

    // All children killed before parent
    expect(killOrder).toContain(2000);
    expect(killOrder).toContain(3000);
    expect(killOrder[killOrder.length - 1]).toBe(1000);
  });

  it("should handle nested process tree (grandchildren)", () => {
    const killOrder: number[] = [];
    process.kill = vi.fn().mockImplementation((pid: number) => {
      killOrder.push(pid);
    });

    // Tree: 1000 -> 2000 -> 3000
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("pgrep -P 1000")) return "2000\n";
      if (cmd.includes("pgrep -P 2000")) return "3000\n";
      if (cmd.includes("pgrep -P 3000")) return "";
      return "";
    });

    killProcessTree(1000);

    // Deepest first: 3000, then 2000, then 1000
    expect(killOrder).toEqual([3000, 2000, 1000]);
  });

  it("should skip invalid PIDs", () => {
    // Parent 1000 has "abc", empty line, and 123 as children
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("pgrep -P 1000")) return "abc\n\n123\n";
      if (cmd.includes("pgrep -P 123")) return "";
      return "";
    });

    killProcessTree(1000);

    // Should only call kill for valid PIDs (123 and 1000), skipping "abc" and empty
    expect(process.kill).toHaveBeenCalledTimes(2);
    expect(process.kill).toHaveBeenCalledWith(123, "SIGKILL");
    expect(process.kill).toHaveBeenCalledWith(1000, "SIGKILL");
  });

  it("should ignore errors when process is already dead", () => {
    mockedExecSync.mockReturnValue("");
    process.kill = vi.fn().mockImplementation(() => {
      throw new Error("ESRCH");
    });

    // Should not throw
    expect(() => killProcessTree(1000)).not.toThrow();
  });

  it("should ignore errors when pgrep fails", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("pgrep failed");
    });

    // Should not throw
    expect(() => killProcessTree(1000)).not.toThrow();
  });
});
