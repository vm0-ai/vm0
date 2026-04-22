import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  logsListContract,
  zeroSchedulesMainContract,
  zeroSchedulesEnableContract,
  zeroScheduleRunContract,
  type ScheduleResponse,
} from "@vm0/core";

const context = testContext();

const SCHEDULE_ID = "f0000001-0000-4000-a000-000000000001";

function mockAPIs(overrides: Partial<ScheduleResponse> = {}) {
  setMockSchedules([
    createMockScheduleResponse({
      displayName: "Zero",
      description: "Daily morning briefing",
      ...overrides,
    }),
  ]);
  server.use(
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
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
    mockApi(logsListContract.list, ({ request, respond }) => {
      const url = new URL(request.url);
      const cursor = url.searchParams.get("cursor") ?? "";
      const cursorIndex = cursors.indexOf(cursor);
      const effectiveIndex = cursorIndex === -1 ? 0 : cursorIndex;
      const nextCursor =
        effectiveIndex + 1 < cursors.length
          ? cursors[effectiveIndex + 1]
          : null;

      return respond(200, {
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
            prompt: "Scheduled run prompt",
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

async function openRunHistoryTab() {
  click(screen.getByText(/Run History/i));
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
      mockApi(zeroSchedulesEnableContract.disable, ({ respond }) => {
        toggleCalled = true;
        return respond(
          200,
          createMockScheduleResponse({
            displayName: "Zero",
            description: "Daily morning briefing",
            enabled: false,
          }),
        );
      }),
      mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
        if (toggleCalled) {
          return respond(200, {
            schedules: [
              createMockScheduleResponse({
                displayName: "Zero",
                description: "Daily morning briefing",
                enabled: false,
              }),
            ],
          });
        }
        return respond(200, {
          schedules: [
            createMockScheduleResponse({
              displayName: "Zero",
              description: "Daily morning briefing",
              enabled: true,
            }),
          ],
        });
      }),
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, { threads: [] });
      }),
    );

    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /Disable this schedule/i }),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch", { name: /Disable this schedule/i }));

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
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        return respond(200, {
          schedule: createMockScheduleResponse({
            displayName: "Zero",
            description: "Updated",
          }),
          created: false,
        });
      }),
    );
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const descriptionInput = screen.getByPlaceholderText(
      "Leave blank to auto-generate",
    );
    await fill(descriptionInput, "Updated");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Save"));

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
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    click(screen.getByText("Delete schedule"));

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
      mockApi(zeroSchedulesMainContract.list, ({ respond }) => {
        return respond(200, {
          schedules: [
            createMockScheduleResponse({
              displayName: "Zero",
              description: "Daily morning briefing",
              ...(saved ? { prompt: newPrompt } : {}),
            }),
          ],
        });
      }),
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, { threads: [] });
      }),
      mockApi(zeroSchedulesMainContract.deploy, ({ respond }) => {
        saved = true;
        return respond(200, {
          schedule: createMockScheduleResponse({
            displayName: "Zero",
            description: "Daily morning briefing",
            prompt: newPrompt,
          }),
          created: false,
        });
      }),
    );
    const user = userEvent.setup();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const instructionsTab = screen.getAllByRole("tab").find((el) => {
      return /Instructions/.test(el.textContent ?? "");
    });
    click(instructionsTab!);

    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const editor = document.querySelector("[contenteditable]") as HTMLElement;
    editor!.focus();
    await user.keyboard("{Control>}a{/Control}New instruction content");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Save"));

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
    click(instructionsTab!);

    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const editor = document.querySelector("[contenteditable]") as HTMLElement;
    editor!.focus();
    await user.keyboard("{Control>}a{/Control}Something different");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(screen.getByText("Discard"));

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
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab();

    click(screen.getByLabelText("Next page"));
    await waitFor(() => {
      expect(screen.getByText(/Page 2/)).toBeInTheDocument();
    });

    click(screen.getByLabelText("Previous page"));
    await waitFor(() => {
      expect(screen.getByText(/Page 1/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination next button works (SCHED-D-027)", () => {
  it("should show the next page when next button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab();

    click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination forward 2 button works (SCHED-D-028)", () => {
  it("should jump forward two pages when forward 2 button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab();

    click(screen.getByLabelText("Forward 2 pages"));

    await waitFor(() => {
      expect(screen.getByText(/Page 3 of 3/)).toBeInTheDocument();
    });
  });
});

describe("zero schedule detail page - pagination back 2 button works (SCHED-D-029)", () => {
  it("should jump back two pages when back 2 button is clicked", async () => {
    mockAPIs();
    mockLogsWithPagination();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();
    await openRunHistoryTab();

    click(screen.getByLabelText("Forward 2 pages"));
    await waitFor(() => {
      expect(screen.getByText(/Page 3/)).toBeInTheDocument();
    });

    click(screen.getByLabelText("Back 2 pages"));
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
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        capturedLimit = url.searchParams.get("limit");
        return respond(200, {
          data: [],
          pagination: {
            hasMore: false,
            nextCursor: null,
            totalPages: 2,
          },
          filters: { statuses: [], sources: [], agents: [] },
        });
      }),
    );
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    click(screen.getByText(/Run History/i));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Rows per page" }),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("combobox", { name: "Rows per page" }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "20" })).toBeInTheDocument();
    });

    click(screen.getByRole("option", { name: "20" }));

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
      mockApi(logsListContract.list, ({ request, respond }) => {
        const url = new URL(request.url);
        capturedStatus = url.searchParams.get("status");
        return respond(200, {
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
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    click(screen.getByText(/Run History/i));

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("combobox", { name: "Status filter" }));

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: /completed/i }),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("option", { name: /completed/i }));

    await waitFor(() => {
      expect(capturedStatus).toBe("completed");
    });
  });
});

describe("zero schedule detail page - run now button triggers immediate run (SCHED-D-032)", () => {
  it("should show a run started confirmation when run now button is clicked", async () => {
    mockAPIs();
    server.use(
      mockApi(zeroScheduleRunContract.run, ({ respond }) => {
        return respond(201, { runId: "r0000000-0000-4000-a000-000000000001" });
      }),
    );
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    click(screen.getByText(/Run now/i));

    await waitFor(() => {
      expect(screen.getByText(/Run started/i)).toBeInTheDocument();
    });
  });
});

// The Agent field is shown on the detail page but must be read-only: changing
// it would create a duplicate schedule on the new agent rather than moving the
// existing one (the backend keys schedule lookup on agentId + name). Keep the
// control visible for context and disable it to match actual behavior.
describe("zero schedule detail page - agent field is read-only", () => {
  it("should render the agent select as disabled", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const agentDescription = await screen.findByText(
      /The agent is fixed once a schedule is created/i,
    );
    // Row structure is <row><leftCol><p label /><p description /></leftCol>
    // <rightCol>{Select}</rightCol></row>; walk up two parents to the row.
    const row = agentDescription.parentElement?.parentElement;
    expect(row).not.toBeNull();

    const agentCombobox = within(row!).getByRole("combobox");
    expect(agentCombobox).toBeDisabled();
  });
});

describe("zero schedule detail page - tab triggers switch between tabs (SCHED-D-033)", () => {
  it("should switch content when tab triggers are clicked", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: `/schedules/${SCHEDULE_ID}` });
    await waitForPageLoad();

    const instructionsTab = screen.getAllByRole("tab").find((el) => {
      return /Instructions/.test(el.textContent ?? "");
    });
    click(instructionsTab!);
    await waitFor(() => {
      expect(document.querySelector("[contenteditable]")).toBeInTheDocument();
    });

    const runHistoryTab = screen.getAllByRole("tab").find((el) => {
      return /Run History/.test(el.textContent ?? "");
    });
    click(runHistoryTab!);
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Status filter" }),
      ).toBeInTheDocument();
    });

    const settingsTab = screen.getAllByRole("tab").find((el) => {
      return /Settings/.test(el.textContent ?? "");
    });
    click(settingsTab!);
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Leave blank to auto-generate"),
      ).toBeInTheDocument();
    });
  });
});
