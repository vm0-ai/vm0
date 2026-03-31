import { describe, expect, it } from "vitest";
import { getTimezoneLabel, COMMON_TIMEZONES } from "../cron.ts";

describe("getTimezoneLabel", () => {
  it("returns label with GMT offset prefix for known timezone", () => {
    const label = getTimezoneLabel("Asia/Shanghai");
    expect(label).toMatch(/^\(GMT[+-]\d{2}:\d{2}\)/);
    expect(label).toMatch(/^\(GMT\+08:00\)/);
  });

  it("returns label with GMT offset prefix for Etc/UTC", () => {
    const label = getTimezoneLabel("Etc/UTC");
    expect(label).toMatch(/^\(GMT\+00:00\)/);
    expect(label).toContain("UTC");
  });

  it("falls back to IANA string with underscores replaced for unknown timezone", () => {
    const label = getTimezoneLabel("America/Indiana/Knox");
    expect(label).toMatch(/^\(GMT/);
    expect(label).toContain("America/Indiana/Knox");
  });

  it("does not include standalone UTC in COMMON_TIMEZONES", () => {
    expect(COMMON_TIMEZONES).not.toContain("UTC");
  });

  it("includes Etc/UTC in COMMON_TIMEZONES", () => {
    expect(COMMON_TIMEZONES).toContain("Etc/UTC");
  });
});
