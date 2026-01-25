import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import {
  generateCronExpression,
  detectTimezone,
  extractVarsAndSecrets,
  validateTimeFormat,
  validateDateFormat,
  getTomorrowDateLocal,
  getCurrentTimeLocal,
  toISODateTime,
} from "../../../lib/domain/schedule-utils";

describe("schedule init utilities", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = mkdtempSync(path.join(os.tmpdir(), "test-schedule-init-"));
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("generateCronExpression", () => {
    it("should generate daily cron expression", () => {
      expect(generateCronExpression("daily", "09:00")).toBe("0 9 * * *");
      expect(generateCronExpression("daily", "14:30")).toBe("30 14 * * *");
      expect(generateCronExpression("daily", "00:00")).toBe("0 0 * * *");
      expect(generateCronExpression("daily", "23:59")).toBe("59 23 * * *");
    });

    it("should generate weekly cron expression", () => {
      // Monday = 1
      expect(generateCronExpression("weekly", "09:00", 1)).toBe("0 9 * * 1");
      // Sunday = 0
      expect(generateCronExpression("weekly", "10:30", 0)).toBe("30 10 * * 0");
      // Friday = 5
      expect(generateCronExpression("weekly", "17:00", 5)).toBe("0 17 * * 5");
    });

    it("should generate monthly cron expression", () => {
      expect(generateCronExpression("monthly", "09:00", 1)).toBe("0 9 1 * *");
      expect(generateCronExpression("monthly", "12:00", 15)).toBe(
        "0 12 15 * *",
      );
      expect(generateCronExpression("monthly", "23:00", 31)).toBe(
        "0 23 31 * *",
      );
    });

    it("should use default day when not provided", () => {
      // Weekly defaults to Monday (1)
      expect(generateCronExpression("weekly", "09:00")).toBe("0 9 * * 1");
      // Monthly defaults to 1st
      expect(generateCronExpression("monthly", "09:00")).toBe("0 9 1 * *");
    });
  });

  describe("detectTimezone", () => {
    it("should return a valid IANA timezone", () => {
      const tz = detectTimezone();
      expect(tz).toBeTruthy();
      expect(typeof tz).toBe("string");
      // Should be a valid timezone that Intl can recognize
      expect(() => {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
      }).not.toThrow();
    });
  });

  describe("validateTimeFormat", () => {
    it("should accept valid time formats", () => {
      expect(validateTimeFormat("09:00")).toBe(true);
      expect(validateTimeFormat("9:00")).toBe(true);
      expect(validateTimeFormat("00:00")).toBe(true);
      expect(validateTimeFormat("23:59")).toBe(true);
      expect(validateTimeFormat("12:30")).toBe(true);
    });

    it("should reject invalid time formats", () => {
      expect(validateTimeFormat("9")).toBe(
        "Invalid format. Use HH:MM (e.g., 09:00)",
      );
      expect(validateTimeFormat("900")).toBe(
        "Invalid format. Use HH:MM (e.g., 09:00)",
      );
      expect(validateTimeFormat("9:0")).toBe(
        "Invalid format. Use HH:MM (e.g., 09:00)",
      );
      expect(validateTimeFormat("")).toBe(
        "Invalid format. Use HH:MM (e.g., 09:00)",
      );
    });

    it("should reject out of range hours", () => {
      expect(validateTimeFormat("24:00")).toBe("Hour must be 0-23");
      expect(validateTimeFormat("25:00")).toBe("Hour must be 0-23");
    });

    it("should reject out of range minutes", () => {
      expect(validateTimeFormat("09:60")).toBe("Minute must be 0-59");
      expect(validateTimeFormat("09:99")).toBe("Minute must be 0-59");
    });
  });

  describe("extractVarsAndSecrets", () => {
    it("should return empty arrays when vm0.yaml does not exist", () => {
      // vm0.yaml doesn't exist in tempDir
      const result = extractVarsAndSecrets();
      expect(result).toEqual({ vars: [], secrets: [] });
    });

    it("should extract vars and secrets from environment syntax", () => {
      // Create real vm0.yaml file
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-agent:
    provider: anthropic
    environment:
      API_KEY: "\${{ vars.API_KEY }}"
      BASE_URL: "\${{ vars.BASE_URL }}"
      DATABASE_URL: "\${{ secrets.DATABASE_URL }}"
      API_SECRET: "\${{ secrets.API_SECRET }}"
`,
      );

      const result = extractVarsAndSecrets();
      expect(result.vars).toContain("API_KEY");
      expect(result.vars).toContain("BASE_URL");
      expect(result.secrets).toContain("DATABASE_URL");
      expect(result.secrets).toContain("API_SECRET");
    });

    it("should extract vars and secrets from environment patterns", () => {
      // Create real vm0.yaml file
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-agent:
    provider: anthropic
    environment:
      MY_VAR: "\${{ vars.MY_VAR }}"
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
      ANOTHER: "\${{ vars.ANOTHER }}"
`,
      );

      const result = extractVarsAndSecrets();
      expect(result.vars).toContain("MY_VAR");
      expect(result.vars).toContain("ANOTHER");
      expect(result.secrets).toContain("MY_SECRET");
    });

    it("should not duplicate variable names", () => {
      // Create real vm0.yaml file
      writeFileSync(
        path.join(tempDir, "vm0.yaml"),
        `version: "1.0"
agents:
  my-agent:
    provider: anthropic
    environment:
      KEY1: "\${{ vars.API_KEY }}"
      KEY2: "\${{ vars.API_KEY }}"
`,
      );

      const result = extractVarsAndSecrets();
      // API_KEY should only appear once
      expect(result.vars.filter((v) => v === "API_KEY")).toHaveLength(1);
    });

    it("should handle parse errors gracefully", () => {
      // Create real vm0.yaml file with invalid content
      writeFileSync(path.join(tempDir, "vm0.yaml"), "invalid: yaml: content:");

      const result = extractVarsAndSecrets();
      expect(result).toEqual({ vars: [], secrets: [] });
    });
  });

  describe("validateDateFormat", () => {
    it("should accept valid date formats", () => {
      expect(validateDateFormat("2025-01-15")).toBe(true);
      expect(validateDateFormat("2024-12-31")).toBe(true);
      expect(validateDateFormat("2000-01-01")).toBe(true);
      expect(validateDateFormat("2100-06-15")).toBe(true);
    });

    it("should reject invalid date formats", () => {
      expect(validateDateFormat("2025-1-15")).toBe(
        "Invalid format. Use YYYY-MM-DD (e.g., 2025-01-15)",
      );
      expect(validateDateFormat("25-01-15")).toBe(
        "Invalid format. Use YYYY-MM-DD (e.g., 2025-01-15)",
      );
      expect(validateDateFormat("2025/01/15")).toBe(
        "Invalid format. Use YYYY-MM-DD (e.g., 2025-01-15)",
      );
      expect(validateDateFormat("")).toBe(
        "Invalid format. Use YYYY-MM-DD (e.g., 2025-01-15)",
      );
    });

    it("should reject out of range years", () => {
      expect(validateDateFormat("1999-01-15")).toBe(
        "Year must be between 2000 and 2100",
      );
      expect(validateDateFormat("2101-01-15")).toBe(
        "Year must be between 2000 and 2100",
      );
    });

    it("should reject out of range months", () => {
      expect(validateDateFormat("2025-00-15")).toBe("Month must be 1-12");
      expect(validateDateFormat("2025-13-15")).toBe("Month must be 1-12");
    });

    it("should reject out of range days", () => {
      expect(validateDateFormat("2025-01-00")).toBe("Day must be 1-31");
      expect(validateDateFormat("2025-01-32")).toBe("Day must be 1-31");
    });

    it("should reject invalid dates like Feb 30", () => {
      expect(validateDateFormat("2025-02-30")).toBe("Invalid date");
      expect(validateDateFormat("2025-02-29")).toBe("Invalid date"); // 2025 is not a leap year
      expect(validateDateFormat("2024-02-29")).toBe(true); // 2024 is a leap year
      expect(validateDateFormat("2025-04-31")).toBe("Invalid date"); // April has 30 days
    });
  });

  describe("getTomorrowDateLocal", () => {
    it("should return a date in YYYY-MM-DD format", () => {
      const result = getTomorrowDateLocal();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should return tomorrow's date", () => {
      const result = getTomorrowDateLocal();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const expected = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
      expect(result).toBe(expected);
    });
  });

  describe("getCurrentTimeLocal", () => {
    it("should return a time in HH:MM format", () => {
      const result = getCurrentTimeLocal();
      expect(result).toMatch(/^\d{2}:\d{2}$/);
    });

    it("should return the current time", () => {
      const result = getCurrentTimeLocal();
      const now = new Date();
      const expected = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      expect(result).toBe(expected);
    });
  });

  describe("toISODateTime", () => {
    it("should convert human-readable format to ISO", () => {
      const result = toISODateTime("2025-01-15 14:30");
      // The result should be a valid ISO string
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      // Check that the date components are preserved
      const date = new Date(result);
      expect(date.getFullYear()).toBe(2025);
      expect(date.getMonth()).toBe(0); // January
      expect(date.getDate()).toBe(15);
    });

    it("should pass through ISO format unchanged", () => {
      const isoStr = "2025-01-15T14:30:00.000Z";
      expect(toISODateTime(isoStr)).toBe(isoStr);
    });

    it("should handle different times", () => {
      const result1 = toISODateTime("2025-12-31 23:59");
      expect(result1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);

      const result2 = toISODateTime("2025-01-01 00:00");
      expect(result2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });

  // Note: resolveScheduleByName is tested via E2E tests in
  // e2e/tests/02-parallel/t20-vm0-schedule.bats (global resolution tests)
  // since it requires real API calls and mocking internal modules is not acceptable
});
