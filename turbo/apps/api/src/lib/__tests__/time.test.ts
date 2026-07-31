import { describe, expect, it } from "vitest";

import {
  clearMockNow,
  mockNow,
  now,
  nowDate,
  withMockNowForTest,
  withNowScopeForTest,
} from "../time";

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

    expect(nowDate()).toStrictEqual(new Date(timestamp));
  });

  it("clears mocked time", () => {
    mockNow(123);
    clearMockNow();

    expect(now()).not.toBe(123);
  });

  it("isolates scoped clocks across concurrent async work", async () => {
    const [first, second] = await Promise.all([
      withMockNowForTest(123, async () => {
        await Promise.resolve();
        mockNow(124);
        await Promise.resolve();
        return now();
      }),
      withMockNowForTest(456, async () => {
        await Promise.resolve();
        expect(now()).toBe(456);
        await Promise.resolve();
        return now();
      }),
    ]);

    expect(first).toBe(124);
    expect(second).toBe(456);
  });

  it("isolates a real-time scope from the legacy global override", async () => {
    mockNow(123);

    await withNowScopeForTest(async () => {
      expect(now()).not.toBe(123);
      mockNow(456);
      await Promise.resolve();
      expect(now()).toBe(456);
      clearMockNow();
      expect(now()).not.toBe(123);
    });

    expect(now()).toBe(123);
  });
});
