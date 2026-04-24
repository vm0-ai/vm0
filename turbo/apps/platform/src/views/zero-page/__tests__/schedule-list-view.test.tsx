import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/core/contracts/zero-schedules";

const context = testContext();
const mockApi = createMockApi(context);

function createEnabledSchedule(): ScheduleResponse {
  return createMockScheduleResponse({
    id: "f0000001-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    cronExpression: "0 9 * * 1-5",
    prompt: "Summarize yesterday's threads",
    enabled: true,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  });
}

function createDisabledSchedule(): ScheduleResponse {
  return createMockScheduleResponse({
    id: "f0000001-0000-4000-a000-000000000002",
    displayName: "Zero",
    name: "disabled-task",
    cronExpression: "0 12 * * *",
    prompt: "Disabled task",
    enabled: false,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
  });
}

function mockScheduleAPI(schedules = [createEnabledSchedule()]) {
  setMockSchedules(schedules);
}

describe("schedule list view - empty state (SCHED-D-080)", () => {
  it("renders empty state image and message when no schedules exist", async () => {
    mockScheduleAPI([]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "No schedules" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set up a schedule and your agents will handle the rest.",
      ),
    ).toBeInTheDocument();
  });
});

describe("schedule list view - schedule list renders (SCHED-D-081)", () => {
  it("renders schedule entries in a table with expected columns", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByText("Summarize yesterday's threads")[0],
      ).toBeInTheDocument();
    });
    expect(
      screen.getAllByRole("columnheader").find((el) => {
        return /Instruction/.test(el.textContent ?? "");
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("columnheader").find((el) => {
        return /Schedule at/.test(el.textContent ?? "");
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("columnheader").find((el) => {
        return /Status/.test(el.textContent ?? "");
      }),
    ).toBeDefined();
  });
});

describe("schedule list view - agent labels (SCHED-D-082)", () => {
  it("renders agent labels for each schedule entry when multiple agents are present", async () => {
    mockScheduleAPI([
      createEnabledSchedule(),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000022",
        agentId: "c0000000-0000-4000-a000-000000000002",
        displayName: "Research Agent",
        name: "research-task",
        cronExpression: "0 9 * * 1-5",
        prompt: "Research daily summary",
      }),
    ]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getAllByText("Zero")[0]).toBeInTheDocument();
    });
    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
  });
});

describe("schedule list view - time and timezone (SCHED-D-083)", () => {
  it("renders schedule time and timezone for each entry", async () => {
    mockScheduleAPI([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000001",
        displayName: "Zero",
        name: "morning-briefing",
        cronExpression: "0 9 * * 1-5",
        prompt: "Summarize yesterday's threads",
        timezone: "America/New_York",
      }),
    ]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByText(/Every weekday at 9:00 AM/)[0],
      ).toBeInTheDocument();
    });
    // Timezone rendered with underscores replaced by spaces
    expect(screen.getAllByText(/America\/New York/)[0]).toBeInTheDocument();
  });
});

describe("schedule list view - enabled/disabled indicator (SCHED-D-084)", () => {
  it("renders toggle switches with distinct labels for enabled and disabled schedules", async () => {
    mockScheduleAPI([createEnabledSchedule(), createDisabledSchedule()]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      // Enabled schedule: switch shows "Disable <time>"
      expect(
        screen.getAllByLabelText(/^Disable Every weekday at 9:00 AM/)[0],
      ).toBeInTheDocument();
    });
    // Disabled schedule: switch shows "Enable <time>"
    expect(
      screen.getAllByLabelText(/^Enable Every day at 12:00 PM/)[0],
    ).toBeInTheDocument();
  });
});

describe("schedule list view - running action indicator (SCHED-D-085)", () => {
  it("shows Starting indicator in run menu while a run is in progress", async () => {
    const hangDeferred = createDeferredPromise<void>(context.signal);
    setMockSchedules([createEnabledSchedule()]);
    server.use(
      mockApi(zeroScheduleRunContract.run, async ({ respond }) => {
        await hangDeferred.promise;
        return respond(201, { runId: "run-1" });
      }),
    );
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          "More actions for Every weekday at 9:00 AM",
        )[0],
      ).toBeInTheDocument();
    });

    // Open the menu
    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Run now");
        }),
      ).toBeDefined();
    });

    // Click Run now — API hangs
    click(
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes("Run now");
      })!,
    );

    // Re-open the menu to see "Starting…"
    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );
    await waitFor(() => {
      expect(screen.getAllByText(/Starting/)[0]).toBeInTheDocument();
    });

    hangDeferred.resolve();
  });
});

describe("schedule list view - empty state add schedule button (SCHED-D-086)", () => {
  it("opens the schedule form dialog when Add schedule is clicked in empty state", async () => {
    mockScheduleAPI([]);
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(screen.getByText("No runs scheduled")).toBeInTheDocument();
    });

    // The empty state "Add schedule" button
    const addButtons = screen.getAllByRole("button").filter((el) => {
      return /Add schedule/i.test(el.textContent ?? "");
    });
    // At least one Add schedule button exists in the empty state
    expect(addButtons.length).toBeGreaterThan(0);
    click(addButtons[addButtons.length - 1]);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Add schedule" }),
      ).toBeInTheDocument();
    });
  });
});

describe("schedule list view - row click navigates to detail (SCHED-D-087)", () => {
  it("navigates to the schedule detail page when a schedule row is clicked", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          /Open schedule Summarize yesterday's threads/,
        )[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText(
        /Open schedule Summarize yesterday's threads/,
      )[0],
    );

    await waitFor(() => {
      expect(pathname()).toBe(
        "/schedules/f0000001-0000-4000-a000-000000000001",
      );
    });
  });
});

describe("schedule list view - row renders as anchor link (SCHED-D-087b)", () => {
  it("renders schedule rows as <a> elements with href so middle/right-click open in new tab works", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          /Open schedule Summarize yesterday's threads/,
        )[0],
      ).toBeInTheDocument();
    });

    const link = screen.getAllByLabelText(
      /Open schedule Summarize yesterday's threads/,
    )[0];
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute(
      "href",
      "/schedules/f0000001-0000-4000-a000-000000000001",
    );
  });
});

describe("schedule list view - toggle switch (SCHED-D-088)", () => {
  it("sends enable action when a disabled schedule toggle is clicked", async () => {
    let capturedAction: string | null = null;

    setMockSchedules([createDisabledSchedule()]);
    server.use(
      mockApi(zeroSchedulesEnableContract.enable, ({ respond }) => {
        capturedAction = "enable";
        return respond(200, createDisabledSchedule());
      }),
      mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
        capturedAction = "disable";
        return respond(200, createDisabledSchedule());
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(/^Enable Every day at 12:00 PM/)[0],
      ).toBeInTheDocument();
    });

    click(screen.getAllByLabelText(/^Enable Every day at 12:00 PM/)[0]);

    await waitFor(() => {
      expect(capturedAction).toBe("enable");
    });
  });
});

describe("schedule list view - more actions dropdown (SCHED-D-089)", () => {
  it("opens a dropdown with Run now, Edit, and Delete options", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          "More actions for Every weekday at 9:00 AM",
        )[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Run now");
        }),
      ).toBeDefined();
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Edit");
        }),
      ).toBeDefined();
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Delete");
        }),
      ).toBeDefined();
    });
  });
});

describe("schedule list view - run now action (SCHED-D-090)", () => {
  it("calls the run API with the schedule id when Run now is clicked", async () => {
    let capturedScheduleId: string | null = null;

    setMockSchedules([createEnabledSchedule()]);
    server.use(
      mockApi(zeroScheduleRunContract.run, ({ body, respond }) => {
        capturedScheduleId = body.scheduleId;
        return respond(201, { runId: "run-1" });
      }),
    );

    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          "More actions for Every weekday at 9:00 AM",
        )[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Run now");
        }),
      ).toBeDefined();
    });

    click(
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes("Run now");
      })!,
    );

    await waitFor(() => {
      expect(capturedScheduleId).toBeTruthy();
    });
    expect(capturedScheduleId).toBe("f0000001-0000-4000-a000-000000000001");
  });
});

describe("schedule list view - edit action (SCHED-D-091)", () => {
  it("navigates to the schedule detail page when Edit is clicked", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          "More actions for Every weekday at 9:00 AM",
        )[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Edit");
        }),
      ).toBeDefined();
    });

    click(
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes("Edit");
      })!,
    );

    await waitFor(() => {
      expect(pathname()).toBe(
        "/schedules/f0000001-0000-4000-a000-000000000001",
      );
    });
  });
});

describe("schedule list view - delete action (SCHED-D-092)", () => {
  it("shows delete confirmation dialog when Delete is clicked", async () => {
    mockScheduleAPI();
    detachedSetupPage({ context, path: "/schedules" });

    await waitFor(() => {
      expect(
        screen.getAllByLabelText(
          "More actions for Every weekday at 9:00 AM",
        )[0],
      ).toBeInTheDocument();
    });

    click(
      screen.getAllByLabelText("More actions for Every weekday at 9:00 AM")[0],
    );

    await waitFor(() => {
      expect(
        screen.getAllByRole("menuitem").find((el) => {
          return el.textContent?.includes("Delete");
        }),
      ).toBeDefined();
    });

    click(
      screen.getAllByRole("menuitem").find((el) => {
        return el.textContent?.includes("Delete");
      })!,
    );

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
  });
});
