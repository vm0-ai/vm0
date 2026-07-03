import { describe, expect, it } from "vitest";

import { hasExplicitDateTimeOffset, parseScheduledAtTime } from "../timezone";

describe("parseScheduledAtTime", () => {
  it("keeps explicit UTC and offset inputs as exact instants", () => {
    expect(
      parseScheduledAtTime("2026-06-22T07:55:00Z", "Asia/Shanghai"),
    ).toMatchObject({
      ok: true,
      hasExplicitOffset: true,
      date: new Date("2026-06-22T07:55:00.000Z"),
    });
    expect(
      parseScheduledAtTime("2026-06-22T15:55:00+08:00", "UTC"),
    ).toMatchObject({
      ok: true,
      hasExplicitOffset: true,
      date: new Date("2026-06-22T07:55:00.000Z"),
    });
  });

  it("interprets local wall-clock inputs in the provided timezone", () => {
    const parsed = parseScheduledAtTime("2026-06-22T15:55:00", "Asia/Shanghai");

    expect(parsed).toMatchObject({
      ok: true,
      hasExplicitOffset: false,
      date: new Date("2026-06-22T07:55:00.000Z"),
    });
  });

  it("rejects nonexistent and ambiguous local wall-clock inputs", () => {
    expect(
      parseScheduledAtTime("2026-03-08T02:30:00", "America/New_York"),
    ).toMatchObject({
      ok: false,
      code: "nonexistent-local-time",
    });
    expect(
      parseScheduledAtTime("2026-11-01T01:30:00", "America/New_York"),
    ).toMatchObject({
      ok: false,
      code: "ambiguous-local-time",
    });
  });
});

describe("hasExplicitDateTimeOffset", () => {
  it("detects UTC and numeric timezone offsets", () => {
    expect(hasExplicitDateTimeOffset("2026-06-22T07:55:00Z")).toBe(true);
    expect(hasExplicitDateTimeOffset("2026-06-22T15:55:00+08:00")).toBe(true);
    expect(hasExplicitDateTimeOffset("2026-06-22T15:55:00+0800")).toBe(true);
    expect(hasExplicitDateTimeOffset("2026-06-22T15:55:00")).toBe(false);
  });
});
