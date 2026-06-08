import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";

const context = testContext();

describe("schedule page", () => {
  it("should render the schedule page with empty schedules", async () => {
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    expect(screen.getByText("Week view")).toBeInTheDocument();
    expect(screen.queryByText("No runs scheduled")).not.toBeInTheDocument();
  });

  it("should render schedule entries when data is present", async () => {
    setMockSchedules([
      createMockScheduleResponse({
        id: "f0000002-0000-4000-a000-000000000001",
        name: "test-schedule",
        cronExpression: "0 9 * * *",
        prompt: "Daily standup summary",
      }),
    ]);

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Daily standup summary")[0],
      ).toBeInTheDocument();
    });
  });

  it("should show Add schedule button", async () => {
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    // The "Add schedule" button appears in the header and in the empty state
    const addButtons = queryAllByRoleFast("button").filter((el) => {
      return /Add schedule/.test(el.textContent ?? "");
    });
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
  });
});
