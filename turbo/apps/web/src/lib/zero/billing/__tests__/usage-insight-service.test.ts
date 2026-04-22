import { describe, it, expect } from "vitest";
// eslint-disable-next-line web/no-direct-db-in-tests -- Pure function test: algorithmic timezone boundary logic
import { startOfDayInTz } from "../usage-insight-service";

describe("startOfDayInTz", () => {
  it("returns midnight UTC for a UTC afternoon time", () => {
    const date = new Date("2026-04-22T15:30:45.123Z");
    const result = startOfDayInTz(date, "UTC");
    expect(result.toISOString()).toBe("2026-04-22T00:00:00.123Z");
  });

  it("returns midnight in positive-offset timezone (Asia/Tokyo)", () => {
    // 2026-04-22T15:00:00Z = 2026-04-23T00:00:00+09:00 in Tokyo
    const date = new Date("2026-04-22T15:00:00.000Z");
    const result = startOfDayInTz(date, "Asia/Tokyo");
    // Midnight in Tokyo on 2026-04-23 = 2026-04-22T15:00:00Z
    expect(result.toISOString()).toBe("2026-04-22T15:00:00.000Z");
  });

  it("returns midnight in negative-offset timezone (America/Los_Angeles)", () => {
    // 2026-04-22T15:00:00Z = 2026-04-22T08:00:00-07:00 in LA
    const date = new Date("2026-04-22T15:00:00.000Z");
    const result = startOfDayInTz(date, "America/Los_Angeles");
    // Midnight in LA on 2026-04-22 = 2026-04-22T07:00:00Z
    expect(result.toISOString()).toBe("2026-04-22T07:00:00.000Z");
  });

  it("handles spring-forward DST boundary (America/New_York)", () => {
    // March 8 2026 at 12:00 UTC = 07:00 EST (before spring-forward at 2 AM)
    const date = new Date("2026-03-08T12:00:00.000Z");
    const result = startOfDayInTz(date, "America/New_York");
    // Midnight EST on March 8 = 05:00 UTC
    expect(result.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });

  it("handles fall-back DST boundary (America/New_York)", () => {
    // November 1 2026 at 12:00 UTC = 08:00 EDT (after fall-back at 2 AM)
    const date = new Date("2026-11-01T12:00:00.000Z");
    const result = startOfDayInTz(date, "America/New_York");
    // Midnight EDT on Nov 1 = 04:00 UTC
    expect(result.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("preserves sub-millisecond offset from input", () => {
    const date = new Date("2026-04-22T15:30:45.456Z");
    const result = startOfDayInTz(date, "UTC");
    expect(result.getMilliseconds()).toBe(456);
  });
});
