import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vol } from "memfs";
import {
  parseFirecrackerCmdline,
  parseMitmproxyCmdline,
  findFirecrackerProcesses,
  findMitmproxyProcess,
  findProcessByVmId,
} from "../process.js";

// Use memfs for filesystem simulation
vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

// Helper to build null-separated command line strings
function cmdline(...args: string[]): string {
  return args.join("\x00") + "\x00";
}

describe("process discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vol.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== Pure function tests ====================

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

  // ==================== Filesystem tests (with memfs) ====================

  describe("findFirecrackerProcesses", () => {
    it("finds firecracker processes from /proc", () => {
      vol.fromJSON({
        "/proc/1234/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-aaaabbbb/firecracker.sock",
        ),
        "/proc/5678/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pid: 1234,
        vmId: "aaaabbbb",
        socketPath: "/tmp/vm0-aaaabbbb/firecracker.sock",
      });
    });

    it("returns empty array when /proc is empty", () => {
      vol.fromJSON({ "/proc/.keep": "" });

      expect(findFirecrackerProcesses()).toEqual([]);
    });

    it("handles multiple firecracker processes", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-11112222/firecracker.sock",
        ),
        "/proc/200/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-33334444/firecracker.sock",
        ),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(2);
      expect(result.map((p) => p.vmId).sort()).toEqual([
        "11112222",
        "33334444",
      ]);
    });

    it("skips non-numeric entries in /proc", () => {
      vol.fromJSON({
        "/proc/self/cmdline": "self",
        "/proc/cpuinfo": "cpu info",
        "/proc/1234/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-eeeeeeee/firecracker.sock",
        ),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]?.vmId).toBe("eeeeeeee");
    });

    it("skips when cmdline file does not exist", () => {
      vol.fromJSON({
        "/proc/1234/.placeholder": "",
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(0);
    });

    it("skips processes with unreadable cmdline", async () => {
      vol.fromJSON({
        "/proc/1234/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-aaaabbbb/firecracker.sock",
        ),
        "/proc/5678/cmdline": "will be mocked to throw",
      });

      // Spy on readFileSync to throw EACCES for specific path
      const fs = await import("fs");
      const originalReadFileSync = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation((path, options) => {
        if (path === "/proc/5678/cmdline") {
          const error = new Error("EACCES: permission denied");
          (error as NodeJS.ErrnoException).code = "EACCES";
          throw error;
        }
        return originalReadFileSync(path, options);
      });

      const result = findFirecrackerProcesses();

      // Should find the readable process and skip the unreadable one
      expect(result).toHaveLength(1);
      expect(result[0]?.vmId).toBe("aaaabbbb");
    });
  });

  describe("findProcessByVmId", () => {
    it("finds process by vmId", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-aaaaaaaa/firecracker.sock",
        ),
        "/proc/200/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-bbbbbbbb/firecracker.sock",
        ),
      });

      const result = findProcessByVmId("bbbbbbbb");

      expect(result).toEqual({
        pid: 200,
        vmId: "bbbbbbbb",
        socketPath: "/tmp/vm0-bbbbbbbb/firecracker.sock",
      });
    });

    it("returns null when vmId not found", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/tmp/vm0-aaaaaaaa/firecracker.sock",
        ),
      });

      const result = findProcessByVmId("notfound");

      expect(result).toBeNull();
    });
  });

  describe("findMitmproxyProcess", () => {
    it("finds mitmproxy process", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
        "/proc/2000/cmdline": cmdline(
          "mitmdump",
          "-p",
          "8080",
          "-s",
          "addon.py",
        ),
      });

      const result = findMitmproxyProcess();

      expect(result).toEqual({ pid: 2000, port: 8080 });
    });

    it("returns null when no mitmproxy process found", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
      });

      const result = findMitmproxyProcess();

      expect(result).toBeNull();
    });

    it("returns null when /proc is empty", () => {
      vol.fromJSON({ "/proc/.keep": "" });

      const result = findMitmproxyProcess();

      expect(result).toBeNull();
    });

    it("finds mitmproxy without port", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("mitmproxy", "-s", "addon.py"),
      });

      const result = findMitmproxyProcess();

      expect(result).toEqual({ pid: 1000, port: undefined });
    });
  });
});
