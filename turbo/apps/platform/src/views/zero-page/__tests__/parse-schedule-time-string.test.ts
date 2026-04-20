import { describe, expect, it } from "vitest";
import { parseScheduleTimeString } from "../zero-schedule-card.tsx";

describe("parseScheduleTimeString", () => {
  it("should always default timezone to UTC", () => {
    // parseScheduleTimeString parses a human-readable time string, which does
    // NOT carry timezone information. Callers that re-save a schedule must use
    // the stored entry.timezone rather than parsed.timezone to avoid silently
    // overwriting a non-UTC timezone with UTC.
    const cases = [
      "Every weekday at 9:00 AM",
      "Every day at 2:00 PM",
      "Every week on Wednesday at 10:00 AM",
      "Every month on day 15 at 9:00 AM",
      "Every 15 minutes",
      "Once on 2026-06-15 at 2:30 PM",
    ];
    for (const timeStr of cases) {
      expect(parseScheduleTimeString(timeStr).timezone).toBe("UTC");
    }
  });

  it("should parse every_weekday frequency", () => {
    const result = parseScheduleTimeString("Every weekday at 9:00 AM");
    expect(result.freq).toBe("every_weekday");
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });

  it("should parse every_n_minutes frequency from minutes", () => {
    const result = parseScheduleTimeString("Every 15 minutes");
    expect(result.freq).toBe("every_n_minutes");
    expect(result.loopMinutes).toBe(15);
  });

  it("should parse every_n_minutes frequency from seconds", () => {
    const result = parseScheduleTimeString("Every 300 seconds");
    expect(result.freq).toBe("every_n_minutes");
    expect(result.loopMinutes).toBe(5);
  });

  it("should parse once frequency", () => {
    const result = parseScheduleTimeString("Once on 2026-06-15 at 2:30 PM");
    expect(result.freq).toBe("once");
    expect(result.date).toBe("2026-06-15");
    expect(result.hour).toBe(14);
    expect(result.minute).toBe(30);
  });

  it("should parse weekly frequency", () => {
    const result = parseScheduleTimeString(
      "Every week on Wednesday at 10:00 AM",
    );
    expect(result.freq).toBe("every_week");
    expect(result.hour).toBe(10);
    expect(result.minute).toBe(0);
  });

  it("should parse monthly frequency", () => {
    const result = parseScheduleTimeString("Every month on day 15 at 9:00 AM");
    expect(result.freq).toBe("every_month");
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });

  it("should parse 'Now' as now frequency", () => {
    const result = parseScheduleTimeString("Now");
    expect(result.freq).toBe("now");
  });
});
