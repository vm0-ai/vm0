import { describe, expect, it } from "vitest";

import { calculateNextRun } from "../zero-schedules.service";

describe("calculateNextRun", () => {
  it("uses the supplied start date when finding the next cron run", () => {
    const nextRunAt = calculateNextRun(
      "0 9 * * *",
      "UTC",
      new Date("2099-01-01T04:00:00.000Z"),
    );

    expect(nextRunAt?.toISOString()).toBe("2099-01-01T09:00:00.000Z");
  });
});
