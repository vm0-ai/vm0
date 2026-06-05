import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  createMockScheduleResponse,
  setMockSchedules,
} from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function setLegacySchedule() {
  setMockSchedules([
    createMockScheduleResponse({
      id: SCHEDULE_ID,
      displayName: null,
      name: "morning-briefing",
      prompt: "Summarize yesterday's threads",
      chatThreadId: null,
    }),
  ]);
}

describe("migrate schedules dialog", () => {
  it("does not open when scheduled chat is off", async () => {
    setLegacySchedule();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });

    expect(screen.queryByText("Migrate schedules to chat")).toBeNull();
  });

  it("opens from the bootstrap shell on schedule routes when org scheduled chat is on", async () => {
    setLegacySchedule();
    detachedSetupPage({
      context,
      path: `/schedules/${SCHEDULE_ID}`,
      featureSwitches: { [FeatureSwitchKey.ScheduledChat]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Migrate schedules to chat")).toBeInTheDocument();
    });
    expect(screen.getByText("morning-briefing")).toBeInTheDocument();
  });

  it("cannot be skipped before migration", async () => {
    setLegacySchedule();
    detachedSetupPage({
      context,
      path: "/schedules",
      featureSwitches: { [FeatureSwitchKey.ScheduledChat]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Migrate schedules to chat")).toBeInTheDocument();
    });
    expect(screen.queryByText("Not now")).toBeNull();

    const closeButton = screen.queryAllByLabelText("Close")[0];
    if (closeButton) {
      click(closeButton);
    }

    await waitFor(() => {
      expect(screen.getByText("Migrate schedules to chat")).toBeInTheDocument();
    });
  });

  it("closes after migrating all legacy schedules", async () => {
    setLegacySchedule();
    detachedSetupPage({
      context,
      path: "/schedules",
      featureSwitches: { [FeatureSwitchKey.ScheduledChat]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Migrate schedules to chat")).toBeInTheDocument();
    });

    const migrateButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Migrate to chat thread");
    });
    expect(migrateButton).toBeDefined();
    click(migrateButton!);

    await waitFor(() => {
      expect(screen.queryByText("Migrate schedules to chat")).toBeNull();
    });
  });
});
