import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "fs";
import {
  generateCronExpression,
  detectTimezone,
  extractVarsAndSecrets,
  validateTimeFormat,
} from "../../../lib/domain/schedule-utils";

// Mock fs module for file-based tests
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

describe("schedule init utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("should return empty arrays when vm0.yaml does not exist", () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = extractVarsAndSecrets();
      expect(result).toEqual({ vars: [], secrets: [] });
    });

    it("should extract experimental_vars and experimental_secrets", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`
version: "1.0"
agents:
  my-agent:
    provider: anthropic
    experimental_vars:
      - API_KEY
      - BASE_URL
    experimental_secrets:
      - DATABASE_URL
      - API_SECRET
`);

      const result = extractVarsAndSecrets();
      expect(result.vars).toContain("API_KEY");
      expect(result.vars).toContain("BASE_URL");
      expect(result.secrets).toContain("DATABASE_URL");
      expect(result.secrets).toContain("API_SECRET");
    });

    it("should extract vars and secrets from environment patterns", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`
version: "1.0"
agents:
  my-agent:
    provider: anthropic
    environment:
      MY_VAR: "\${{ vars.MY_VAR }}"
      MY_SECRET: "\${{ secrets.MY_SECRET }}"
      ANOTHER: "\${{ vars.ANOTHER }}"
`);

      const result = extractVarsAndSecrets();
      expect(result.vars).toContain("MY_VAR");
      expect(result.vars).toContain("ANOTHER");
      expect(result.secrets).toContain("MY_SECRET");
    });

    it("should not duplicate variable names", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(`
version: "1.0"
agents:
  my-agent:
    provider: anthropic
    experimental_vars:
      - API_KEY
    environment:
      KEY1: "\${{ vars.API_KEY }}"
      KEY2: "\${{ vars.API_KEY }}"
`);

      const result = extractVarsAndSecrets();
      // API_KEY should only appear once
      expect(result.vars.filter((v) => v === "API_KEY")).toHaveLength(1);
    });

    it("should handle parse errors gracefully", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue("invalid: yaml: content:");

      const result = extractVarsAndSecrets();
      expect(result).toEqual({ vars: [], secrets: [] });
    });
  });
});
