import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseTime, formatTimestamp } from "../time-parser";

describe("time-parser", () => {
  describe("parseTime", () => {
    describe("relative time", () => {
      beforeEach(() => {
        // Mock Date.now() to return a fixed timestamp
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2024-01-15T12:00:00Z"));
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("parses seconds", () => {
        const result = parseTime("30s");
        // 12:00:00 - 30 seconds = 11:59:30
        expect(result).toBe(new Date("2024-01-15T11:59:30Z").getTime());
      });

      it("parses minutes", () => {
        const result = parseTime("5m");
        // 12:00:00 - 5 minutes = 11:55:00
        expect(result).toBe(new Date("2024-01-15T11:55:00Z").getTime());
      });

      it("parses hours", () => {
        const result = parseTime("2h");
        // 12:00:00 - 2 hours = 10:00:00
        expect(result).toBe(new Date("2024-01-15T10:00:00Z").getTime());
      });

      it("parses days", () => {
        const result = parseTime("1d");
        // Jan 15 12:00 - 1 day = Jan 14 12:00
        expect(result).toBe(new Date("2024-01-14T12:00:00Z").getTime());
      });

      it("parses weeks", () => {
        const result = parseTime("1w");
        // Jan 15 12:00 - 1 week = Jan 8 12:00
        expect(result).toBe(new Date("2024-01-08T12:00:00Z").getTime());
      });
    });

    describe("Unix timestamp", () => {
      it("parses Unix timestamp in seconds", () => {
        // 1705312200 = 2024-01-15T10:30:00Z
        const result = parseTime("1705312200");
        expect(result).toBe(1705312200000);
      });

      it("parses Unix timestamp in milliseconds", () => {
        const result = parseTime("1705312200000");
        expect(result).toBe(1705312200000);
      });
    });

    describe("ISO 8601 format", () => {
      it("parses ISO 8601 with timezone", () => {
        const result = parseTime("2024-01-15T10:30:00Z");
        expect(result).toBe(new Date("2024-01-15T10:30:00Z").getTime());
      });

      it("parses ISO 8601 with offset", () => {
        const result = parseTime("2024-01-15T10:30:00+00:00");
        expect(result).toBe(new Date("2024-01-15T10:30:00Z").getTime());
      });

      it("parses date-only format", () => {
        const result = parseTime("2024-01-15");
        expect(result).toBe(new Date("2024-01-15").getTime());
      });
    });

    describe("error cases", () => {
      it("throws on invalid format", () => {
        expect(() => parseTime("invalid")).toThrow("Invalid time format");
      });

      it("throws on unknown unit", () => {
        expect(() => parseTime("5x")).toThrow("Invalid time format");
      });

      it("throws on empty string", () => {
        expect(() => parseTime("")).toThrow("Invalid time format");
      });
    });
  });

  describe("formatTimestamp", () => {
    it("formats timestamp as ISO 8601", () => {
      const timestamp = new Date("2024-01-15T10:30:00Z").getTime();
      const result = formatTimestamp(timestamp);
      expect(result).toBe("2024-01-15T10:30:00.000Z");
    });
  });
});
