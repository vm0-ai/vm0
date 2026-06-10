import { screen, waitFor } from "@testing-library/react";
import {
  logsListContract,
  type LogsListResponse,
} from "@vm0/api-contracts/contracts/logs";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const agentId = "c0000000-0000-4000-a000-000000000001";
const scheduleId = "f0000001-0000-4000-a000-000000000201";

function createZeroAgent(): TeamComposeItem {
  return {
    id: agentId,
    ownerId: "test-user-123",
    displayName: "Zero",
    description: "Default workspace agent",
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2026-03-10T00:00:00Z",
  };
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

function mockScheduleDetailStory(): void {
  const runs: LogsListResponse["data"] = [
    {
      id: "a0000000-0000-4000-a000-000000000201",
      sessionId: "session-schedule-1",
      agentId,
      displayName: "Zero",
      framework: "claude-code",
      triggerSource: "schedule",
      triggerAgentName: null,
      scheduleId,
      status: "completed",
      prompt: "Send morning brief to the team channel",
      createdAt: "2026-03-10T14:30:00Z",
      startedAt: "2026-03-10T14:30:01Z",
      completedAt: "2026-03-10T14:30:04Z",
    },
    {
      id: "a0000000-0000-4000-a000-000000000202",
      sessionId: "session-schedule-2",
      agentId,
      displayName: "Zero",
      framework: "claude-code",
      triggerSource: "schedule",
      triggerAgentName: null,
      scheduleId,
      status: "failed",
      prompt: "Send morning brief to the team channel",
      createdAt: "2026-03-09T14:30:00Z",
      startedAt: "2026-03-09T14:30:01Z",
      completedAt: "2026-03-09T14:30:06Z",
    },
  ];

  context.mocks.data.team([createZeroAgent()]);
  context.mocks.data.schedules([
    createMockScheduleResponse({
      id: scheduleId,
      agentId,
      displayName: "Zero",
      name: "weekday-morning-brief",
      cronExpression: "30 14 * * 1-5",
      timezone: "UTC",
      prompt: "Send morning brief to the team channel",
      description: "Morning brief",
      enabled: true,
      nextRunAt: "2026-03-11T14:30:00Z",
    }),
  ]);
  context.mocks.api(logsListContract.list, ({ query, respond }) => {
    const data =
      query.scheduleId === scheduleId
        ? runs.filter((run) => {
            return query.status === undefined || run.status === query.status;
          })
        : [];
    return respond(200, {
      data,
      pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      filters: {
        statuses: ["completed", "failed"],
        sources: ["schedule"],
        agents: [agentId],
      },
    });
  });
}

describe("zero schedule detail page", () => {
  it("shows the schedule settings, run history, status changes, and delete confirmation", async () => {
    mockScheduleDetailStory();

    detachedSetupPage({ context, path: `/schedules/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Every weekday at 2:30 PM")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Morning brief")).toBeInTheDocument();
    expect(screen.getByText("Danger zone")).toBeInTheDocument();

    await fill(screen.getByDisplayValue("Morning brief"), "Team morning brief");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(buttonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Schedule updated")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(/Team morning brief/u)).toBeInTheDocument();

    click(tabByText("Run History"));

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
    });
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("3.0s")).toBeInTheDocument();
    expect(screen.getByText("5.0s")).toBeInTheDocument();

    click(screen.getByLabelText("Status filter"));
    click(screen.getByRole("option", { name: "Failed" }));

    await waitFor(() => {
      expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
      expect(screen.getByText("5.0s")).toBeInTheDocument();
      expect(screen.queryByText("Done")).not.toBeInTheDocument();
      expect(screen.queryByText("3.0s")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("Status filter"));
    click(screen.getByRole("option", { name: "All status" }));

    await waitFor(() => {
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
      expect(screen.getByText("3.0s")).toBeInTheDocument();
      expect(screen.getByText("5.0s")).toBeInTheDocument();
    });

    click(tabByText("Settings"));
    click(screen.getByLabelText("Disable this schedule"));

    await waitFor(() => {
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Enable this schedule")).toBeInTheDocument();

    click(buttonByText("Delete schedule"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText("Delete schedule?")).toBeInTheDocument();

    click(buttonByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete schedule?")).not.toBeInTheDocument();
    });

    click(buttonByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText(/Run started/u)).toBeInTheDocument();
      expect(screen.getByText("View activity")).toBeInTheDocument();
    });

    click(buttonByText("Delete schedule"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    click(buttonByText("Delete"));

    await waitFor(() => {
      expect(screen.getByText("Schedule deleted")).toBeInTheDocument();
      expect(screen.getByText("Scheduled tasks")).toBeInTheDocument();
    });
  });
});
