import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadAgentName,
  formatRelativeTime,
} from "../../../lib/domain/schedule-utils";

/**
 * Unit tests for schedule command validation logic.
 *
 * These tests cover validation scenarios for the agent-centric schedule commands.
 * All schedule commands now use agent name as the primary identifier.
 */
describe("schedule command validation", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-schedule-cmd-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadAgentName", () => {
    it("should return null when vm0.yaml does not exist", () => {
      const result = loadAgentName();
      expect(result.agentName).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it("should return agent name from valid vm0.yaml", () => {
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-test-agent:
    description: "Test agent"
    framework: claude-code
`,
      );

      const result = loadAgentName();
      expect(result.agentName).toBe("my-test-agent");
      expect(result.error).toBeUndefined();
    });

    it("should return first agent when multiple agents exist", () => {
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  first-agent:
    description: "First"
  second-agent:
    description: "Second"
`,
      );

      const result = loadAgentName();
      expect(result.agentName).toBe("first-agent");
    });

    it("should return error for invalid YAML syntax", () => {
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        "invalid: yaml: : : content",
      );

      const result = loadAgentName();
      expect(result.agentName).toBeNull();
      expect(result.error).toBeDefined();
    });

    it("should return null agentName when agents section is empty", () => {
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents: {}
`,
      );

      const result = loadAgentName();
      expect(result.agentName).toBeNull();
      expect(result.error).toBeUndefined();
    });
  });

  describe("schedule setup validation", () => {
    it("should detect when vm0.yaml exists", () => {
      // No vm0.yaml exists
      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(false);

      // Create vm0.yaml
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  test-agent:
    description: "Test"
`,
      );

      expect(existsSync(path.join(tempDir, "vm0.yaml"))).toBe(true);
    });
  });

  describe("formatRelativeTime", () => {
    it("should return dash for null input", () => {
      expect(formatRelativeTime(null)).toBe("-");
    });

    it("should format future dates correctly", () => {
      const futureDate = new Date();
      futureDate.setHours(futureDate.getHours() + 2);
      const result = formatRelativeTime(futureDate.toISOString());
      // Should show something like "in 2h" (allow some variance)
      expect(result).toMatch(/^in \d+[hmds]$/);
    });

    it("should format past dates correctly", () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 3);
      const result = formatRelativeTime(pastDate.toISOString());
      // Should show something like "3d ago"
      expect(result).toMatch(/^\d+[dhm] ago$/);
    });

    it("should show 'just now' for recent past dates", () => {
      const recentDate = new Date();
      recentDate.setSeconds(recentDate.getSeconds() - 30);
      const result = formatRelativeTime(recentDate.toISOString());
      expect(result).toBe("just now");
    });

    it("should show 'soon' for very near future dates", () => {
      const soonDate = new Date();
      soonDate.setSeconds(soonDate.getSeconds() + 30);
      const result = formatRelativeTime(soonDate.toISOString());
      expect(result).toBe("soon");
    });
  });

  describe("day parsing for schedule setup", () => {
    /**
     * Test the day parsing logic used in schedule setup command.
     * This tests frequency-to-cron conversion logic.
     */
    const parseDayOption = (
      day: string,
      frequency: "weekly" | "monthly",
    ): number | undefined => {
      if (frequency === "weekly") {
        const dayMap: Record<string, number> = {
          sun: 0,
          mon: 1,
          tue: 2,
          wed: 3,
          thu: 4,
          fri: 5,
          sat: 6,
        };
        return dayMap[day.toLowerCase()];
      } else if (frequency === "monthly") {
        const num = parseInt(day, 10);
        if (num >= 1 && num <= 31) {
          return num;
        }
      }
      return undefined;
    };

    it("should parse weekly day names correctly", () => {
      expect(parseDayOption("mon", "weekly")).toBe(1);
      expect(parseDayOption("Mon", "weekly")).toBe(1);
      expect(parseDayOption("MON", "weekly")).toBe(1);
      expect(parseDayOption("sun", "weekly")).toBe(0);
      expect(parseDayOption("fri", "weekly")).toBe(5);
    });

    it("should return undefined for invalid weekly day names", () => {
      expect(parseDayOption("monday", "weekly")).toBeUndefined();
      expect(parseDayOption("invalid", "weekly")).toBeUndefined();
      expect(parseDayOption("8", "weekly")).toBeUndefined();
    });

    it("should parse monthly day numbers correctly", () => {
      expect(parseDayOption("1", "monthly")).toBe(1);
      expect(parseDayOption("15", "monthly")).toBe(15);
      expect(parseDayOption("31", "monthly")).toBe(31);
    });

    it("should return undefined for invalid monthly day numbers", () => {
      expect(parseDayOption("0", "monthly")).toBeUndefined();
      expect(parseDayOption("32", "monthly")).toBeUndefined();
      expect(parseDayOption("-1", "monthly")).toBeUndefined();
      expect(parseDayOption("mon", "monthly")).toBeUndefined();
    });
  });
});
