import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getCpuPercent,
  getMemoryInfo,
  getDiskInfo,
  collectMetrics,
} from "../scripts/lib/metrics";

describe("metrics", () => {
  beforeEach(() => {
    // Suppress log output (log module uses console.error for all levels)
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getCpuPercent", () => {
    it("should return CPU percentage between 0 and 100", () => {
      const result = getCpuPercent();

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });
  });

  describe("getMemoryInfo", () => {
    it("should return [used, total] with positive values where used <= total", () => {
      const [used, total] = getMemoryInfo();

      expect(total).toBeGreaterThan(0);
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThanOrEqual(total);
    });
  });

  describe("getDiskInfo", () => {
    it("should return [used, total] with positive values where used <= total", () => {
      const [used, total] = getDiskInfo();

      expect(total).toBeGreaterThan(0);
      expect(used).toBeGreaterThan(0);
      expect(used).toBeLessThanOrEqual(total);
    });
  });

  describe("collectMetrics", () => {
    it("should combine all metrics into single object with valid ranges", () => {
      const metrics = collectMetrics();

      expect(metrics.cpu).toBeGreaterThanOrEqual(0);
      expect(metrics.cpu).toBeLessThanOrEqual(100);
      expect(metrics.mem_total).toBeGreaterThan(0);
      expect(metrics.mem_used).toBeGreaterThan(0);
      expect(metrics.mem_used).toBeLessThanOrEqual(metrics.mem_total);
      expect(metrics.disk_total).toBeGreaterThan(0);
      expect(metrics.disk_used).toBeGreaterThan(0);
      expect(metrics.disk_used).toBeLessThanOrEqual(metrics.disk_total);
      expect(metrics.ts).toBeDefined();
      expect(new Date(metrics.ts).toISOString()).toBe(metrics.ts);
    });
  });
});
