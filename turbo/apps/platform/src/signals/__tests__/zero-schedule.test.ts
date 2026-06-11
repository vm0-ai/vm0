import { describe, expect, it } from "vitest";

import {
  allOrgScheduleEntries$,
  fetchAllOrgSchedules$,
} from "../zero-page/zero-schedule.ts";
import { createMockScheduleResponse } from "../../mocks/handlers/api-schedules.ts";
import { testContext } from "./test-helpers.ts";

describe("allOrgScheduleEntries$", () => {
  const ctx = testContext();

  it("displays schedule times in the user's preferred timezone", async () => {
    ctx.mocks.data.schedules([
      createMockScheduleResponse({
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      }),
    ]);
    ctx.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });

    await ctx.store.set(fetchAllOrgSchedules$, ctx.signal);
    const entries = await ctx.store.get(allOrgScheduleEntries$);

    expect(entries[0].time).toBe("Every day at 5:00 PM");
    expect(entries[0].timezone).toBe("Asia/Shanghai");
  });

  it("displays once schedule times in the user's preferred timezone", async () => {
    ctx.mocks.data.schedules([
      createMockScheduleResponse({
        triggerType: "once",
        cronExpression: null,
        atTime: "2026-06-11T10:00:00.000Z",
        timezone: "UTC",
      }),
    ]);
    ctx.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });

    await ctx.store.set(fetchAllOrgSchedules$, ctx.signal);
    const entries = await ctx.store.get(allOrgScheduleEntries$);

    expect(entries[0].time).toBe("Once on 2026-06-11 at 6:00 PM");
    expect(entries[0].timezone).toBe("Asia/Shanghai");
  });

  it("all entries use the same timezone regardless of stored timezone", async () => {
    ctx.mocks.data.schedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000001",
        cronExpression: "0 9 * * *",
        timezone: "UTC",
        createdAt: "2026-06-01T00:00:00Z",
      }),
      createMockScheduleResponse({
        id: "f0000002-0000-4000-a000-000000000002",
        cronExpression: "0 18 * * *",
        timezone: "Asia/Shanghai",
        createdAt: "2026-06-02T00:00:00Z",
      }),
    ]);
    ctx.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });

    await ctx.store.set(fetchAllOrgSchedules$, ctx.signal);
    const entries = await ctx.store.get(allOrgScheduleEntries$);

    const timezones = entries.map((e) => {
      return e.timezone;
    });
    expect(new Set(timezones).size).toBe(1);
    expect(timezones[0]).toBe("Asia/Shanghai");
  });
});
