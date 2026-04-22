/**
 * Views tests for zero-unsaved-bar.tsx
 * Tests unsaved changes indicator, save/discard button behavior, and loading state.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroSchedulesMainContract, type ScheduleResponse } from "@vm0/core";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mockAPIs(overrides: Partial<ScheduleResponse> = {}) {
  setMockSchedules([
    createMockScheduleResponse({
      displayName: "Zero",
      timezone: "America/New_York",
      description: "Daily morning briefing",
      ...overrides,
    }),
  ]);
}

async function loadAndMakeDirty() {
  detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
  const input = await waitFor(() => {
    const el = screen.getByPlaceholderText("Leave blank to auto-generate");
    expect(el).toBeInTheDocument();
    return el;
  });
  await fill(input, "My description");
}

describe("zero unsaved bar - unsaved changes indicator (SCHED-D-093)", () => {
  it("shows unsaved changes indicator when settings form is dirty", async () => {
    mockAPIs();
    await loadAndMakeDirty();

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });
  });
});

describe("zero unsaved bar - discard button reverts changes (SCHED-D-095)", () => {
  it("hides unsaved changes bar when Discard is clicked", async () => {
    const user = userEvent.setup();
    mockAPIs();
    await loadAndMakeDirty();

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("discard-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
    });
  });
});

describe("zero unsaved bar - save button persists changes (SCHED-D-096)", () => {
  it("hides unsaved changes bar after successful save", async () => {
    server.use(
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        return respond(200, {
          schedule: createMockScheduleResponse({
            displayName: "Zero",
            timezone: "America/New_York",
            description: "My description",
          }),
          created: false,
        });
      }),
    );

    const user = userEvent.setup();
    mockAPIs();
    await loadAndMakeDirty();

    await waitFor(() => {
      expect(screen.getByTestId("unsaved-bar")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument();
    });
  });
});
