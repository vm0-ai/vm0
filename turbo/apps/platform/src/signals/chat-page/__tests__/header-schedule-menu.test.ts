import { describe, expect, it } from "vitest";

import { schedulesForThread } from "../header-schedule-menu.ts";

describe("header schedule menu", () => {
  it("returns only schedules linked to the current thread", () => {
    const schedules = [
      {
        id: "schedule-1",
        name: "schedule-1",
        title: "Current thread schedule",
        chatThreadId: "thread-1",
      },
      {
        id: "schedule-2",
        name: "schedule-2",
        title: "Other thread schedule",
        chatThreadId: "thread-2",
      },
      {
        id: "schedule-3",
        name: "schedule-3",
        title: "Legacy schedule",
        chatThreadId: null,
      },
    ];

    expect(schedulesForThread(schedules, "thread-1")).toStrictEqual([
      schedules[0],
    ]);
    expect(schedulesForThread(schedules, "thread-3")).toStrictEqual([]);
  });
});
