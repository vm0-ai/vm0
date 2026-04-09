import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";

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
    timezone: "UTC",
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

async function waitForPageLoad() {
  await waitFor(() => {
    expect(
      screen.getAllByText("Daily morning briefing")[0],
    ).toBeInTheDocument();
  });
}

function mockLogsWithPagination() {
  const cursors = ["", "cursor2", "cursor3"];

  server.use(
    http.get("*/api/zero/logs", ({ request }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor") ?? "";
      const cursorIndex = cursors.indexOf(cursor);
      const effectiveIndex = cursorIndex === -1 ? 0 : cursorIndex;
      const nextCursor =
        effectiveIndex + 1 < cursors.length
          ? cursors[effectiveIndex + 1]
          : null;

      return HttpResponse.json({
        data: [
          {
            id: `b000000${String(effectiveIndex + 1)}-0000-4000-a000-000000000001`,
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
        pagination: {
          hasMore: nextCursor !== null,
          nextCursor,
          totalPages: 3,
        },
        filters: {
          statuses: ["completed"],
          sources: ["schedule"],
          agents: [],
        },
      });
    }),
  );
}

async function openRunHistoryTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/Run History/i));
  await waitFor(() => {
    expect(screen.getByText(/Page 1/)).toBeInTheDocument();
  });
}

describe("zero schedule detail page - settings form inputs accept text (SCHED-D-020)", () => {
  it("should accept and display text typed into the description input", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const descriptionInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    await fill(descriptionInput, "New description");

    expect(descriptionInput).toHaveValue("New description");
    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - toggle switch changes enabled state (SCHED-D-021)", () => {
  it("should toggle the schedule between enabled and disabled", async () => {
    let toggleCalled = false;
    server.use(
      http.post("*/api/zero/schedules/morning-briefing/disable", () => {
        toggleCalled = true;
        return HttpResponse.json(createMockSchedule({ enabled: false }));
      }),
      http.get("*/api/zero/schedules", () => {
        if (toggleCalled) {
          return HttpResponse.json({
            schedules: [createMockSchedule({ enabled: false })],
          });
        }
        return HttpResponse.json({
          schedules: [createMockSchedule({ enabled: true })],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
    );

    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Disable this schedule/i }),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("switch", { name: /Disable this schedule/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Enable this schedule/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - settings save button persists changes (SCHED-D-022)", () => {
  it("should save settings and dismiss the unsaved changes banner", async () => {
    mockAPIs();
    server.use(
      http.post("*/api/zero/schedules", () => {
        return HttpResponse.json(
          {
            schedule: createMockSchedule({ description: "Updated" }),
            created: false,
          },
          { status: 200 },
        );
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const descriptionInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    await fill(descriptionInput, "Updated");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Schedule updated")).toBeInTheDocument();
  });
});

describe("zero schedule detail page - delete button opens confirmation dialog (SCHED-D-023)", () => {
  it("should open a confirmation dialog when delete schedule is clicked", async () => {
    mockAPIs();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    await user.click(screen.getByText("Delete schedule"));

    await waitFor(() => {
      expect(screen.getByText("Delete schedule?")).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - instruction save button saves instructions (SCHED-D-024)", () => {
  it("should save instructions and show a success confirmation", async () => {
    const newPrompt = "New instruction content";
    let saved = false;
    server.use(
      http.get("*/api/zero/schedules", () => {
        return HttpResponse.json({
          schedules: [createMockSchedule(saved ? { prompt: newPrompt } : {})],
        });
      }),
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({ threads: [] });
      }),
      http.post("*/api/zero/schedules", () => {
        saved = true;
        return HttpResponse.json(
          {
            schedule: createMockSchedule({ prompt: newPrompt }),
            created: false,
          },
          { status: 200 },
        );
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const instructionsTab = screen.getAllByRole("tab").find((el) => {
      return /Instructions/.test(el.textContent ?? "");
    });
    await user.click(instructionsTab!);

    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const editor = document.querySelector("[contenteditable]");
    await user.click(editor!);
    await user.keyboard("{Control>}a{/Control}New instruction content");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Schedule updated")).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - instruction discard button reverts changes (SCHED-D-025)", () => {
  it("should revert to original instructions when discard is clicked", async () => {
    mockAPIs();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const instructionsTab = screen.getAllByRole("tab").find((el) => {
      return /Instructions/.test(el.textContent ?? "");
    });
    await user.click(instructionsTab!);

    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const editor = document.querySelector("[contenteditable]");
    await user.click(editor!);
    await user.keyboard("{Control>}a{/Control}Something different");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination previous button works (SCHED-D-026)", () => {
  it("should show the previous page when previous button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab(user);

    await user.click(screen.getByLabelText("Next page"));
    await waitFor(() => {
      expect(screen.getByText(/Page 2/)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Previous page"));
    await waitFor(() => {
      expect(screen.getByText(/Page 1/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination next button works (SCHED-D-027)", () => {
  it("should show the next page when next button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab(user);

    await user.click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination forward 2 button works (SCHED-D-028)", () => {
  it("should jump forward two pages when forward 2 button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab(user);

    await user.click(screen.getByLabelText("Forward 2 pages"));

    await waitFor(() => {
      expect(screen.getByText(/Page 3 of 3/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination back 2 button works (SCHED-D-029)", () => {
  it("should jump back two pages when back 2 button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab(user);

    await user.click(screen.getByLabelText("Forward 2 pages"));
    await waitFor(() => {
      expect(screen.getByText(/Page 3/)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Back 2 pages"));
    await waitFor(() => {
      expect(screen.getByText(/Page 1/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - rows per page select changes page size (SCHED-D-030)", () => {
  it("should update table rows when rows per page is changed", async () => {
    mockAPIs();
    let capturedLimit: string | null = null;
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        capturedLimit = url.searchParams.get("limit");
        return HttpResponse.json({
          data: [],
          pagination: {
            hasMore: false,
            nextCursor: null,
            totalPages: undefined,
          },
          filters: { statuses: [], sources: [], agents: [] },
        });
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    await user.click(screen.getByText(/Run History/i));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Rows per page" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("combobox", { name: "Rows per page" }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "20" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("option", { name: "20" }));

    await waitFor(() => {
      expect(capturedLimit).toBe("20");
    });
  });
});

describe("zero schedule detail page - status filter select filters runs (SCHED-D-031)", () => {
  it("should filter run history when a status is selected", async () => {
    mockAPIs();
    let capturedStatus: string | null = null;
    server.use(
      http.get("*/api/zero/logs", ({ request }) => {
        const url = new URL(request.url);
        capturedStatus = url.searchParams.get("status");
        return HttpResponse.json({
          data: [],
          pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          filters: {
            statuses: ["completed", "failed"],
            sources: [],
            agents: [],
          },
        });
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    await user.click(screen.getByText(/Run History/i));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("combobox", { name: "Status filter" }));

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /completed/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("option", { name: /completed/i }));

    await waitFor(() => {
      expect(capturedStatus).toBe("completed");
    });
  });
});

describe("zero schedule detail page - run now button triggers immediate run (SCHED-D-032)", () => {
  it("should show a run started confirmation when run now button is clicked", async () => {
    mockAPIs();
    server.use(
      http.post("*/api/zero/schedules/run", () => {
        return HttpResponse.json(
          { runId: "r0000000-0000-4000-a000-000000000001" },
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    await user.click(screen.getByText(/Run now/i));

    await waitFor(() => {
      expect(screen.getByText(/Run started/i)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - tab triggers switch between tabs (SCHED-D-033)", () => {
  it("should switch content when tab triggers are clicked", async () => {
    mockAPIs();
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const instructionsTab = screen.getAllByRole("tab").find((el) => {
      return /Instructions/.test(el.textContent ?? "");
    });
    await user.click(instructionsTab!);
    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const runHistoryTab = screen.getAllByRole("tab").find((el) => {
      return /Run History/.test(el.textContent ?? "");
    });
    await user.click(runHistoryTab!);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toBeInTheDocument();
    });

    const settingsTab = screen.getAllByRole("tab").find((el) => {
      return /Settings/.test(el.textContent ?? "");
    });
    await user.click(settingsTab!);
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Leave blank to auto-generate"),
      ).toBeInTheDocument();
    });
  });
});
