import { describe, expect, it } from "vitest";

import { clearMockNow, mockNow, now, nowDate } from "../time";

describe("time", () => {
  it("returns a mocked timestamp", () => {
    mockNow(1_700_000_000_000);

    expect(now()).toBe(1_700_000_000_000);
  });

  it("accepts Date values for mocked time", () => {
    const instant = new Date("2026-01-02T03:04:05.000Z");

    mockNow(instant);

    expect(now()).toBe(instant.getTime());
  });

  it("returns a mocked Date", () => {
    const timestamp = 1_700_000_000_000;
    mockNow(timestamp);

    expect(nowDate()).toEqual(new Date(timestamp));
  });

  it("clears mocked time", () => {
    mockNow(123);
    clearMockNow();

    expect(now()).not.toBe(123);
  });
});
