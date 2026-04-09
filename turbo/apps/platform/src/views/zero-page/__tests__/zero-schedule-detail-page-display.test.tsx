import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function createMockSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: SCHEDULE_ID,
    agentId: "c0000000-0000-4000-a000-000000000001",
    displayName: "Zero",
    name: "morning-briefing",
    triggerType: "cron",
    cronExpression: "0 9 * * 1-5",
    atTime: null,
    intervalSeconds: null,
    timezone: "America/New_York",
    prompt: "Summarize yesterday's threads",
    description: "Daily morning briefing",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: "2026-03-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    userId: "test-user-123",
    appendSystemPrompt: null,
    vars: null,
    secretNames: null,
    volumeVersions: null,
    retryStartedAt: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function mockAPIs(overrides: Record<string, unknown> = {}) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules: [createMockSchedule(overrides)] });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

describe("zero schedule detail page - entry details (SCHED-D-012)", () => {
  it("should display prompt, time, and timezone of the schedule", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      // Description is shown as title (may appear in header + breadcrumb)
      expect(
        screen.getAllByText("Daily morning briefing")[0],
      ).toBeInTheDocument();
      // Time string is shown in header subtitle (may appear in multiple places)
      expect(screen.getAllByText(/every weekday/i)[0]).toBeInTheDocument();
      // Timezone appears in the Settings tab (default tab) as a formatted label
      expect(screen.getByText(/Eastern Time/i)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - enabled/disabled state (SCHED-D-013)", () => {
  it("should show Active status when schedule is enabled", async () => {
    mockAPIs({ enabled: true });
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Active")).toBeInTheDocument();
    });
  });

  it("should show Paused status when schedule is disabled", async () => {
    mockAPIs({ enabled: false });
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - toggle loading state (SCHED-D-014)", () => {
  it("should show loading state on the status switch while toggling", async () => {
    let resolveToggle!: () => void;
    const togglePending = new Promise<void>((resolve) => {
      resolveToggle = resolve;
    });

    server.use(
      http.post("*/api/zero/schedules/:name/:action", async () => {
        await togglePending;
        return HttpResponse.json(createMockSchedule());
      }),
    );
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Disable this schedule/i }),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("switch", { name: /Disable this schedule/i }),
    );

    // While toggle is pending, the switch becomes disabled
    await waitFor(() => {
      expect(screen.getByRole("switch")).toBeDisabled();
    });

    resolveToggle();

    await waitFor(() => {
      expect(screen.getByRole("switch")).not.toBeDisabled();
    });
  });
});

describe("zero schedule detail page - instruction editor (SCHED-D-016)", () => {
  it("should display the instruction editor with current content after clicking Instructions tab", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Instructions/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Instructions/i));

    await waitFor(() => {
      // Verify the editor is rendered with the actual prompt content
      expect(
        screen.getByText("Summarize yesterday's threads"),
      ).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - run history table with pagination (SCHED-D-017)", () => {
  it("should render run history table rows and pagination controls", async () => {
    server.use(
      http.get("*/api/zero/logs", () => {
        return HttpResponse.json({
          data: [
            {
              id: "b0000001-0000-4000-a000-000000000001",
              sessionId: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              displayName: "Zero",
              framework: null,
              status: "completed",
              triggerSource: "schedule",
              triggerAgentName: null,
              scheduleId: SCHEDULE_ID,
              createdAt: "2026-03-20T10:00:00Z",
              startedAt: "2026-03-20T10:00:01Z",
              completedAt: "2026-03-20T10:00:30Z",
            },
          ],
          pagination: { hasMore: true, nextCursor: "cursor2", totalPages: 2 },
          filters: {
            statuses: ["completed"],
            sources: ["schedule"],
            agents: [],
          },
        });
      }),
    );
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Run History/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Run History/i));

    await waitFor(() => {
      // Status badge from log data ("completed" renders as "Done") indicates table rows are rendering
      expect(screen.getByText("Done")).toBeInTheDocument();
      // Pagination shows page count
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - status filter dropdown (SCHED-D-018)", () => {
  it("should render the status filter dropdown in the Run History tab", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Run History/i)).toBeInTheDocument();
    });

    await user.click(screen.getByText(/Run History/i));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toBeInTheDocument();
    });
  });
});
