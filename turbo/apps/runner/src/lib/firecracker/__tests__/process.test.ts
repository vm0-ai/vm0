import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import {
  parseFirecrackerCmdline,
  parseMitmproxyCmdline,
  findFirecrackerProcesses,
  findMitmproxyProcess,
  findProcessByVmId,
} from "../process.js";

// Mock fs module
vi.mock("fs");

// Helper to build null-separated command line strings
// Avoids octal escape sequence issues with \0 followed by digits
function cmdline(...args: string[]): string {
  return args.join("\x00") + "\x00";
}

describe("process discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== Pure function tests (no mocks needed) ====================

  describe("parseFirecrackerCmdline", () => {
    it("parses valid firecracker cmdline", () => {
      const input = cmdline(
        "firecracker",
        "--api-sock",
        "/tmp/vm0-abcd1234/firecracker.sock",
      );
      expect(parseFirecrackerCmdline(input)).toEqual({
        vmId: "abcd1234",
        socketPath: "/tmp/vm0-abcd1234/firecracker.sock",
      });
    });

    it("parses cmdline with additional arguments", () => {
      const input = cmdline(
        "/usr/bin/firecracker",
        "--api-sock",
        "/var/run/vm0-12345678/firecracker.sock",
        "--config-file",
        "/etc/fc.json",
      );
      expect(parseFirecrackerCmdline(input)).toEqual({
        vmId: "12345678",
        socketPath: "/var/run/vm0-12345678/firecracker.sock",
      });
    });

    it("returns null for non-firecracker process", () => {
      expect(
        parseFirecrackerCmdline(cmdline("nginx", "-c", "/etc/nginx.conf")),
      ).toBeNull();
    });

    it("returns null when --api-sock is missing", () => {
      expect(
        parseFirecrackerCmdline(
          cmdline("firecracker", "--other-flag", "value"),
        ),
      ).toBeNull();
    });

    it("returns null for invalid socket path format", () => {
      const input = cmdline("firecracker", "--api-sock", "/tmp/other.sock");
      expect(parseFirecrackerCmdline(input)).toBeNull();
    });

    it("returns null for empty cmdline", () => {
      expect(parseFirecrackerCmdline("")).toBeNull();
    });

    it("handles socket path without vm0- prefix", () => {
      const input = cmdline(
        "firecracker",
        "--api-sock",
        "/tmp/firecracker.sock",
      );
      expect(parseFirecrackerCmdline(input)).toBeNull();
    });
  });

  describe("parseMitmproxyCmdline", () => {
    it("parses mitmproxy with -p flag", () => {
      const input = cmdline("mitmproxy", "-p", "8080");
      expect(parseMitmproxyCmdline(input)).toEqual({ port: 8080 });
    });

    it("parses mitmdump with --listen-port flag", () => {
      const input = cmdline(
        "mitmdump",
        "--listen-port",
        "9090",
        "-s",
        "addon.py",
      );
      expect(parseMitmproxyCmdline(input)).toEqual({ port: 9090 });
    });

    it("parses mitmproxy without port flag", () => {
      const input = cmdline("mitmproxy", "-s", "addon.py");
      expect(parseMitmproxyCmdline(input)).toEqual({ port: undefined });
    });

    it("returns null for non-mitmproxy process", () => {
      expect(
        parseMitmproxyCmdline(cmdline("nginx", "-c", "/etc/nginx.conf")),
      ).toBeNull();
    });

    it("returns null for empty cmdline", () => {
      expect(parseMitmproxyCmdline("")).toBeNull();
    });

    it("handles mitmproxy in path", () => {
      const input = cmdline("/usr/bin/mitmproxy", "-p", "7777");
      expect(parseMitmproxyCmdline(input)).toEqual({ port: 7777 });
    });
  });

  // ==================== System interface tests (with mocks) ====================

  describe("findFirecrackerProcesses", () => {
    it("finds firecracker processes from /proc", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue([
        "1234",
        "5678",
        "self",
        "cpuinfo",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (filePath === "/proc/1234/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-aaaabbbb/firecracker.sock",
            );
          }
          if (filePath === "/proc/5678/cmdline") {
            return cmdline("nginx", "-c", "/etc/nginx.conf");
          }
          return "";
        },
      );

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pid: 1234,
        vmId: "aaaabbbb",
        socketPath: "/tmp/vm0-aaaabbbb/firecracker.sock",
      });
    });

    it("returns empty array when /proc is not readable", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      mockReaddirSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(findFirecrackerProcesses()).toEqual([]);
    });

    it("skips processes with unreadable cmdline", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["1234", "5678"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (filePath === "/proc/1234/cmdline") {
            throw new Error("EACCES");
          }
          if (filePath === "/proc/5678/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-ccccdddd/firecracker.sock",
            );
          }
          return "";
        },
      );

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]?.vmId).toBe("ccccdddd");
    });

    it("handles multiple firecracker processes", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["100", "200"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (filePath === "/proc/100/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-11112222/firecracker.sock",
            );
          }
          if (filePath === "/proc/200/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-33334444/firecracker.sock",
            );
          }
          return "";
        },
      );

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.vmId).sort()).toEqual([
        "11112222",
        "33334444",
      ]);
    });

    it("skips non-numeric entries in /proc", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue([
        "self",
        "cpuinfo",
        "meminfo",
        "1234",
      ] as unknown as ReturnType<typeof fs.readdirSync>);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-eeeeeeee/firecracker.sock",
        ),
      );

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
      expect(mockReadFileSync).toHaveBeenCalledWith(
        "/proc/1234/cmdline",
        "utf-8",
      );
    });

    it("skips when cmdline file does not exist", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);

      mockReaddirSync.mockReturnValue(["1234"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(false);

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(0);
    });
  });

  describe("findProcessByVmId", () => {
    it("finds process by vmId", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["100", "200"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (filePath === "/proc/100/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-aaaaaaaa/firecracker.sock",
            );
          }
          if (filePath === "/proc/200/cmdline") {
            return cmdline(
              "firecracker",
              "--api-sock",
              "/tmp/vm0-bbbbbbbb/firecracker.sock",
            );
          }
          return "";
        },
      );

      const result = findProcessByVmId("bbbbbbbb");

      expect(result).toEqual({
        pid: 200,
        vmId: "bbbbbbbb",
        socketPath: "/tmp/vm0-bbbbbbbb/firecracker.sock",
      });
    });

    it("returns null when vmId not found", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["100"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-aaaaaaaa/firecracker.sock",
        ),
      );

      const result = findProcessByVmId("notfound");

      expect(result).toBeNull();
    });
  });

  describe("findMitmproxyProcess", () => {
    it("finds mitmproxy process", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["1000", "2000"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (filePath === "/proc/1000/cmdline") {
            return cmdline("nginx", "-c", "/etc/nginx.conf");
          }
          if (filePath === "/proc/2000/cmdline") {
            return cmdline("mitmdump", "-p", "8080", "-s", "addon.py");
          }
          return "";
        },
      );

      const result = findMitmproxyProcess();

      expect(result).toEqual({ pid: 2000, port: 8080 });
    });

    it("returns null when no mitmproxy process found", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["1000"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        cmdline("nginx", "-c", "/etc/nginx.conf"),
      );

      const result = findMitmproxyProcess();

      expect(result).toBeNull();
    });

    it("returns null when /proc is not readable", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      mockReaddirSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      const result = findMitmproxyProcess();

      expect(result).toBeNull();
    });

    it("finds mitmproxy without port", () => {
      const mockReaddirSync = vi.mocked(fs.readdirSync);
      const mockExistsSync = vi.mocked(fs.existsSync);
      const mockReadFileSync = vi.mocked(fs.readFileSync);

      mockReaddirSync.mockReturnValue(["1000"] as unknown as ReturnType<
        typeof fs.readdirSync
      >);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(cmdline("mitmproxy", "-s", "addon.py"));

      const result = findMitmproxyProcess();

      expect(result).toEqual({ pid: 1000, port: undefined });
    });
  });
});
