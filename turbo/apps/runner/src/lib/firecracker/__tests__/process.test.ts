import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { vol } from "memfs";
import {
  parseFirecrackerCmdline,
  parseMitmproxyCmdline,
  findFirecrackerProcesses,
  findMitmproxyProcesses,
  findProcessByVmId,
} from "../process.js";
import { createVmId as vmId } from "../vm-id.js";

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
    it("parses --api-sock mode (snapshot restore)", () => {
      const input = cmdline(
        "firecracker",
        "--api-sock",
        "/opt/runner/workspaces/vm0-abcd1234/api.sock",
      );
      const result = parseFirecrackerCmdline(input);
      expect(result).toEqual({
        vmId: vmId("abcd1234"),
        baseDir: "/opt/runner",
      });
    });

    it("parses --config-file mode (fresh boot)", () => {
      const input = cmdline(
        "/usr/bin/firecracker",
        "--config-file",
        "/opt/vm0-runner/workspaces/vm0-12345678/config.json",
        "--no-api",
      );
      const result = parseFirecrackerCmdline(input);
      expect(result).toEqual({
        vmId: vmId("12345678"),
        baseDir: "/opt/vm0-runner",
      });
    });

    it("prefers --api-sock over --config-file when both present", () => {
      const input = cmdline(
        "/usr/bin/firecracker",
        "--api-sock",
        "/var/run/runner/workspaces/vm0-aaaaaaaa/api.sock",
        "--config-file",
        "/etc/fc.json",
      );
      const result = parseFirecrackerCmdline(input);
      expect(result).toEqual({
        vmId: vmId("aaaaaaaa"),
        baseDir: "/var/run/runner",
      });
    });

    it("returns null for non-firecracker process", () => {
      expect(
        parseFirecrackerCmdline(cmdline("nginx", "-c", "/etc/nginx.conf")),
      ).toBeNull();
    });

    it("returns null when neither --api-sock nor --config-file present", () => {
      expect(
        parseFirecrackerCmdline(
          cmdline("firecracker", "--other-flag", "value"),
        ),
      ).toBeNull();
    });

    it("returns null for path without vm0- prefix", () => {
      const input = cmdline("firecracker", "--api-sock", "/tmp/other.sock");
      expect(parseFirecrackerCmdline(input)).toBeNull();
    });

    it("returns null for path without workspaces directory", () => {
      const input = cmdline(
        "firecracker",
        "--api-sock",
        "/tmp/vm0-abcd1234/api.sock",
      );
      expect(parseFirecrackerCmdline(input)).toBeNull();
    });

    it("returns null for empty cmdline", () => {
      expect(parseFirecrackerCmdline("")).toBeNull();
    });
  });

  describe("parseMitmproxyCmdline", () => {
    it("parses mitmdump with vm0_registry_path", () => {
      const input = cmdline(
        "mitmdump",
        "--set",
        "vm0_registry_path=/opt/runner/vm-registry.json",
      );
      expect(parseMitmproxyCmdline(input)).toBe("/opt/runner");
    });

    it("parses mitmproxy with vm0_registry_path among other args", () => {
      const input = cmdline(
        "mitmdump",
        "--listen-port",
        "8080",
        "--set",
        "confdir=/opt/proxy",
        "--set",
        "vm0_registry_path=/opt/runner/pr-123/vm-registry.json",
        "-s",
        "addon.py",
      );
      expect(parseMitmproxyCmdline(input)).toBe("/opt/runner/pr-123");
    });

    it("returns null for mitmproxy without vm0_registry_path", () => {
      const input = cmdline("mitmdump", "--listen-port", "8080");
      expect(parseMitmproxyCmdline(input)).toBeNull();
    });

    it("returns null for non-mitmproxy process", () => {
      expect(
        parseMitmproxyCmdline(cmdline("nginx", "-c", "/etc/nginx.conf")),
      ).toBeNull();
    });

    it("returns null for empty cmdline", () => {
      expect(parseMitmproxyCmdline("")).toBeNull();
    });
  });

  // ==================== Filesystem tests (with memfs) ====================

  describe("findFirecrackerProcesses", () => {
    it("finds firecracker processes from /proc", () => {
      vol.fromJSON({
        "/proc/1234/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner/workspaces/vm0-aaaabbbb/api.sock",
        ),
        "/proc/5678/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pid: 1234,
        vmId: vmId("aaaabbbb"),
        baseDir: "/opt/runner",
      });
    });

    it("returns empty array when /proc is empty", () => {
      vol.fromJSON({ "/proc/.keep": "" });

      expect(findFirecrackerProcesses()).toEqual([]);
    });

    it("handles multiple firecracker processes from different runners", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner-a/workspaces/vm0-11112222/api.sock",
        ),
        "/proc/200/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner-b/workspaces/vm0-33334444/api.sock",
        ),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(2);
      expect(result).toContainEqual({
        pid: 100,
        vmId: vmId("11112222"),
        baseDir: "/opt/runner-a",
      });
      expect(result).toContainEqual({
        pid: 200,
        vmId: vmId("33334444"),
        baseDir: "/opt/runner-b",
      });
    });

    it("skips non-numeric entries in /proc", () => {
      vol.fromJSON({
        "/proc/self/cmdline": "self",
        "/proc/cpuinfo": "cpu info",
        "/proc/1234/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner/workspaces/vm0-eeeeeeee/api.sock",
        ),
      });

      const result = findFirecrackerProcesses();

      expect(result).toHaveLength(1);
      expect(result[0]?.vmId).toEqual(vmId("eeeeeeee"));
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
          "/opt/runner/workspaces/vm0-aaaabbbb/api.sock",
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
      expect(result[0]?.vmId).toEqual(vmId("aaaabbbb"));
    });
  });

  describe("findProcessByVmId", () => {
    it("finds process by vmId", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner/workspaces/vm0-aaaaaaaa/api.sock",
        ),
        "/proc/200/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner/workspaces/vm0-bbbbbbbb/api.sock",
        ),
      });

      const result = findProcessByVmId(vmId("bbbbbbbb"));

      expect(result).toEqual({
        pid: 200,
        vmId: vmId("bbbbbbbb"),
        baseDir: "/opt/runner",
      });
    });

    it("returns null when vmId not found", () => {
      vol.fromJSON({
        "/proc/100/cmdline": cmdline(
          "firecracker",
          "--api-sock",
          "/opt/runner/workspaces/vm0-aaaaaaaa/api.sock",
        ),
      });

      const result = findProcessByVmId(vmId("notfound"));

      expect(result).toBeNull();
    });
  });

  describe("findMitmproxyProcesses", () => {
    it("finds mitmproxy processes with registry path", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
        "/proc/2000/cmdline": cmdline(
          "mitmdump",
          "--set",
          "vm0_registry_path=/opt/runner-a/vm-registry.json",
        ),
        "/proc/3000/cmdline": cmdline(
          "mitmdump",
          "--set",
          "vm0_registry_path=/opt/runner-b/vm-registry.json",
        ),
      });

      const result = findMitmproxyProcesses();

      expect(result).toEqual([
        { pid: 2000, baseDir: "/opt/runner-a" },
        { pid: 3000, baseDir: "/opt/runner-b" },
      ]);
    });

    it("returns empty array when no mitmproxy process found", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("nginx", "-c", "/etc/nginx.conf"),
      });

      const result = findMitmproxyProcesses();

      expect(result).toEqual([]);
    });

    it("returns empty array when /proc is empty", () => {
      vol.fromJSON({ "/proc/.keep": "" });

      const result = findMitmproxyProcesses();

      expect(result).toEqual([]);
    });

    it("ignores mitmproxy without registry path", () => {
      vol.fromJSON({
        "/proc/1000/cmdline": cmdline("mitmdump", "-p", "8080"),
      });

      const result = findMitmproxyProcesses();

      expect(result).toEqual([]);
    });
  });
});
