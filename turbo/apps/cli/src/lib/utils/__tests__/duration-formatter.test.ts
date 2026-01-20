import { describe, it, expect } from "vitest";
import { formatDuration } from "../duration-formatter";

describe("formatDuration", () => {
  it("formats hours, minutes, and seconds", () => {
    // 2h 53m 22s = 10402000ms
    expect(formatDuration(10402000)).toBe("2h 53m 22s");
  });

  it("formats hours and minutes without seconds", () => {
    // 2h 30m = 9000000ms
    expect(formatDuration(9000000)).toBe("2h 30m");
  });

  it("formats hours and seconds without minutes", () => {
    // 1h 30s = 3630000ms
    expect(formatDuration(3630000)).toBe("1h 30s");
  });

  it("formats hours only", () => {
    // 2h = 7200000ms
    expect(formatDuration(7200000)).toBe("2h");
  });

  it("formats minutes and seconds (< 1 hour)", () => {
    // 45m 32s = 2732000ms
    expect(formatDuration(2732000)).toBe("45m 32s");
  });

  it("formats minutes only", () => {
    // 15m = 900000ms
    expect(formatDuration(900000)).toBe("15m");
  });

  it("formats seconds only (< 1 minute)", () => {
    // 32s = 32000ms
    expect(formatDuration(32000)).toBe("32s");
  });

  it("returns '< 1s' for sub-second durations", () => {
    expect(formatDuration(500)).toBe("< 1s");
    expect(formatDuration(999)).toBe("< 1s");
    expect(formatDuration(1)).toBe("< 1s");
  });

  it("returns '-' for zero", () => {
    expect(formatDuration(0)).toBe("-");
  });

  it("returns '-' for null", () => {
    expect(formatDuration(null)).toBe("-");
  });

  it("returns '-' for undefined", () => {
    expect(formatDuration(undefined)).toBe("-");
  });

  it("returns '-' for negative values", () => {
    expect(formatDuration(-1000)).toBe("-");
  });

  it("handles exactly 1 second", () => {
    expect(formatDuration(1000)).toBe("1s");
  });

  it("handles exactly 1 minute", () => {
    expect(formatDuration(60000)).toBe("1m");
  });

  it("handles exactly 1 hour", () => {
    expect(formatDuration(3600000)).toBe("1h");
  });
});
