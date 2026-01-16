import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import { execSync } from "child_process";
import {
  getCpuPercent,
  getMemoryInfo,
  getDiskInfo,
  collectMetrics,
} from "../src/lib/metrics";

// Mock the modules
vi.mock("fs");
vi.mock("child_process");

describe("metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getCpuPercent", () => {
    it("should parse /proc/stat and calculate CPU percentage", () => {
      // Sample /proc/stat content
      // cpu  user nice system idle iowait irq softirq steal guest guest_nice
      // cpu  1000 100  500    2000  100    50  50      0     0     0
      // Total = 3800, Idle = 2000 + 100 = 2100
      // CPU% = 100 * (1 - 2100/3800) = 44.74%
      const procStat = `cpu  1000 100 500 2000 100 50 50 0 0 0
cpu0  500 50 250 1000 50 25 25 0 0 0
cpu1  500 50 250 1000 50 25 25 0 0 0`;

      vi.mocked(fs.readFileSync).mockReturnValue(procStat);

      const result = getCpuPercent();

      expect(fs.readFileSync).toHaveBeenCalledWith("/proc/stat", "utf-8");
      expect(result).toBeCloseTo(44.74, 1);
    });

    it("should return 0 for empty /proc/stat", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("");

      const result = getCpuPercent();

      expect(result).toBe(0);
    });

    it("should return 0 when first line doesn't start with 'cpu'", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("invalid line\ncpu 1 2 3 4");

      const result = getCpuPercent();

      expect(result).toBe(0);
    });

    it("should return 0 when total is 0", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("cpu  0 0 0 0 0 0 0 0 0 0");

      const result = getCpuPercent();

      expect(result).toBe(0);
    });

    it("should return 0 on read error", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("File not found");
      });

      const result = getCpuPercent();

      expect(result).toBe(0);
    });

    it("should handle high CPU usage", () => {
      // idle=100, iowait=100, total=10000
      // CPU% = 100 * (1 - 200/10000) = 98%
      vi.mocked(fs.readFileSync).mockReturnValue(
        "cpu  5000 500 4000 100 100 100 100 50 25 25",
      );

      const result = getCpuPercent();

      expect(result).toBeCloseTo(98, 0);
    });

    it("should handle 0% CPU usage (all idle)", () => {
      // All values are 0 except idle
      vi.mocked(fs.readFileSync).mockReturnValue(
        "cpu  0 0 0 10000 0 0 0 0 0 0",
      );

      const result = getCpuPercent();

      expect(result).toBe(0);
    });
  });

  describe("getMemoryInfo", () => {
    it("should parse free -b output and return [used, total]", () => {
      const freeOutput = `              total        used        free      shared  buff/cache   available
Mem:    16777216000  8388608000  4194304000       65536  4194304000  8192000000
Swap:    4294967296           0  4294967296`;

      vi.mocked(execSync).mockReturnValue(freeOutput);

      const [used, total] = getMemoryInfo();

      expect(execSync).toHaveBeenCalledWith("free -b", expect.any(Object));
      expect(total).toBe(16777216000);
      expect(used).toBe(8388608000);
    });

    it("should return [0, 0] when no Mem line found", () => {
      vi.mocked(execSync).mockReturnValue("some invalid output\n");

      const [used, total] = getMemoryInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });

    it("should return [0, 0] on exec error", () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("Command failed");
      });

      const [used, total] = getMemoryInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });

    it("should handle Mem line with missing values", () => {
      vi.mocked(execSync).mockReturnValue("Mem:");

      const [used, total] = getMemoryInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });
  });

  describe("getDiskInfo", () => {
    it("should parse df -B1 / output and return [used, total]", () => {
      const dfOutput = `Filesystem           1B-blocks          Used     Available Use% Mounted on
/dev/sda1        107374182400   53687091200   53687091200  50% /`;

      vi.mocked(execSync).mockReturnValue(dfOutput);

      const [used, total] = getDiskInfo();

      expect(execSync).toHaveBeenCalledWith("df -B1 /", expect.any(Object));
      expect(total).toBe(107374182400);
      expect(used).toBe(53687091200);
    });

    it("should return [0, 0] when output has only header", () => {
      vi.mocked(execSync).mockReturnValue(
        "Filesystem  1B-blocks  Used  Available  Use%  Mounted on",
      );

      const [used, total] = getDiskInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });

    it("should return [0, 0] on exec error", () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("Command failed");
      });

      const [used, total] = getDiskInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });

    it("should handle data line with missing values", () => {
      vi.mocked(execSync).mockReturnValue("Header\n/dev/sda1");

      const [used, total] = getDiskInfo();

      expect(used).toBe(0);
      expect(total).toBe(0);
    });
  });

  describe("collectMetrics", () => {
    it("should combine all metrics into single object", () => {
      // Mock /proc/stat
      vi.mocked(fs.readFileSync).mockReturnValue(
        "cpu  1000 100 500 2000 100 50 50 0 0 0",
      );

      // Mock free -b and df -B1
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd === "free -b") {
          return `              total        used        free      shared  buff/cache   available
Mem:    16000000000  8000000000  4000000000       0  4000000000  8000000000
Swap:             0           0           0`;
        }
        if (cmd === "df -B1 /") {
          return `Filesystem           1B-blocks          Used     Available Use% Mounted on
/dev/sda1        100000000000   50000000000   50000000000  50% /`;
        }
        return "";
      });

      const metrics = collectMetrics();

      expect(metrics).toMatchObject({
        cpu: expect.any(Number),
        mem_used: 8000000000,
        mem_total: 16000000000,
        disk_used: 50000000000,
        disk_total: 100000000000,
      });
      expect(metrics.ts).toBeDefined();
      // Verify timestamp is valid ISO format
      expect(new Date(metrics.ts).toISOString()).toBe(metrics.ts);
    });

    it("should return zeros when all sources fail", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("File not found");
      });
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error("Command failed");
      });

      const metrics = collectMetrics();

      expect(metrics.cpu).toBe(0);
      expect(metrics.mem_used).toBe(0);
      expect(metrics.mem_total).toBe(0);
      expect(metrics.disk_used).toBe(0);
      expect(metrics.disk_total).toBe(0);
    });
  });
});
