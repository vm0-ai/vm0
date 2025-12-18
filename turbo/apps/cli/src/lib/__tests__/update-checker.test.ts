import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  escapeForShell,
  buildRerunCommand,
  getLatestVersion,
  checkAndUpgrade,
} from "../update-checker";
import https from "https";
import { EventEmitter } from "events";

// Mock https module
vi.mock("https", () => ({
  default: {
    get: vi.fn(),
  },
}));

// Mock child_process module
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("update-checker", () => {
  describe("escapeForShell", () => {
    it("should wrap string in double quotes", () => {
      expect(escapeForShell("hello world")).toBe('"hello world"');
    });

    it("should escape internal double quotes", () => {
      expect(escapeForShell('say "hello"')).toBe('"say \\"hello\\""');
    });

    it("should handle empty string", () => {
      expect(escapeForShell("")).toBe('""');
    });

    it("should handle string with multiple double quotes", () => {
      expect(escapeForShell('"a" and "b"')).toBe('"\\"a\\" and \\"b\\""');
    });

    it("should handle string with single quotes (no escaping needed)", () => {
      expect(escapeForShell("it's fine")).toBe('"it\'s fine"');
    });

    it("should handle string with special characters", () => {
      expect(escapeForShell("hello $world")).toBe('"hello $world"');
    });
  });

  describe("buildRerunCommand", () => {
    it("should build command with prompt", () => {
      expect(buildRerunCommand("hello world")).toBe('vm0 cook "hello world"');
    });

    it("should build command without prompt", () => {
      expect(buildRerunCommand(undefined)).toBe("vm0 cook");
    });

    it("should escape double quotes in prompt", () => {
      expect(buildRerunCommand('say "hi"')).toBe('vm0 cook "say \\"hi\\""');
    });

    it("should handle empty string prompt (treated as no prompt)", () => {
      // Empty string is falsy, so treated as no prompt
      expect(buildRerunCommand("")).toBe("vm0 cook");
    });
  });

  describe("getLatestVersion", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should return version from npm registry response", async () => {
      const mockResponse = new EventEmitter() as EventEmitter & {
        on: (event: string, cb: (data?: Buffer) => void) => void;
      };

      vi.mocked(https.get).mockImplementation((_url, callback) => {
        const cb = callback as (res: typeof mockResponse) => void;
        setTimeout(() => {
          cb(mockResponse);
          mockResponse.emit("data", Buffer.from('{"version":"4.11.0"}'));
          mockResponse.emit("end");
        }, 0);
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        return req as ReturnType<typeof https.get>;
      });

      const version = await getLatestVersion();
      expect(version).toBe("4.11.0");
    });

    it("should return null on invalid JSON response", async () => {
      const mockResponse = new EventEmitter();

      vi.mocked(https.get).mockImplementation((_url, callback) => {
        const cb = callback as (res: typeof mockResponse) => void;
        setTimeout(() => {
          cb(mockResponse);
          mockResponse.emit("data", Buffer.from("not valid json"));
          mockResponse.emit("end");
        }, 0);
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        return req as ReturnType<typeof https.get>;
      });

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null when response has no version field", async () => {
      const mockResponse = new EventEmitter();

      vi.mocked(https.get).mockImplementation((_url, callback) => {
        const cb = callback as (res: typeof mockResponse) => void;
        setTimeout(() => {
          cb(mockResponse);
          mockResponse.emit("data", Buffer.from('{"name":"@vm0/cli"}'));
          mockResponse.emit("end");
        }, 0);
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        return req as ReturnType<typeof https.get>;
      });

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null on network error", async () => {
      vi.mocked(https.get).mockImplementation(() => {
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        setTimeout(() => {
          req.emit("error", new Error("Network error"));
        }, 0);
        return req as ReturnType<typeof https.get>;
      });

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });

    it("should return null on timeout", async () => {
      vi.mocked(https.get).mockImplementation(() => {
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.destroy = vi.fn();
        req.setTimeout = (_ms: number, cb: () => void) => {
          setTimeout(cb, 0);
        };
        return req as ReturnType<typeof https.get>;
      });

      const version = await getLatestVersion();
      expect(version).toBeNull();
    });
  });

  describe("checkAndUpgrade", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it("should return false and warn when version check fails", async () => {
      vi.mocked(https.get).mockImplementation(() => {
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        setTimeout(() => {
          req.emit("error", new Error("Network error"));
        }, 0);
        return req as ReturnType<typeof https.get>;
      });

      const result = await checkAndUpgrade("4.10.0", "test prompt");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Could not check for updates"),
      );
    });

    it("should return false when already on latest version", async () => {
      const mockResponse = new EventEmitter();

      vi.mocked(https.get).mockImplementation((_url, callback) => {
        const cb = callback as (res: typeof mockResponse) => void;
        setTimeout(() => {
          cb(mockResponse);
          mockResponse.emit("data", Buffer.from('{"version":"4.10.0"}'));
          mockResponse.emit("end");
        }, 0);
        const req = new EventEmitter() as EventEmitter & {
          setTimeout: (ms: number, cb: () => void) => void;
          destroy: () => void;
        };
        req.setTimeout = vi.fn();
        req.destroy = vi.fn();
        return req as ReturnType<typeof https.get>;
      });

      const result = await checkAndUpgrade("4.10.0", "test prompt");

      expect(result).toBe(false);
      // Should not log EA notice
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Early Access"),
      );
    });
  });
});
