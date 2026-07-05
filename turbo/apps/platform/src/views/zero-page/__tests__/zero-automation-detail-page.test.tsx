import { screen, waitFor } from "@testing-library/react";
import {
  logsListContract,
  type LogsListResponse,
} from "@vm0/api-contracts/contracts/logs";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createMockAutomationView } from "../../../mocks/handlers/automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const agentId = "c0000000-0000-4000-a000-000000000001";
const automationId = "f0000001-0000-4000-a000-000000000201";

function createZeroAgent(): TeamComposeItem {
  return {
    id: agentId,
    ownerId: "test-user-123",
    displayName: "Zero",
    description: "Default workspace agent",
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2026-03-10T00:00:00Z",
  };
}

function mockAutomationDetailStory(): void {
  const runs: LogsListResponse["data"] = [
    {
      id: "a0000000-0000-4000-a000-000000000201",
      sessionId: "session-automation-1",
      agentId,
      displayName: "Zero",
      framework: "claude-code",
      triggerSource: "automation",
      triggerAgentName: null,
      automationId,
      status: "completed",
      prompt: "Send morning brief to the team channel",
      createdAt: "2026-03-10T14:30:00Z",
      startedAt: "2026-03-10T14:30:01Z",
      completedAt: "2026-03-10T14:30:04Z",
    },
    {
      id: "a0000000-0000-4000-a000-000000000202",
      sessionId: "session-automation-2",
      agentId,
      displayName: "Zero",
      framework: "claude-code",
      triggerSource: "automation",
      triggerAgentName: null,
      automationId,
      status: "failed",
      prompt: "Send morning brief to the team channel",
      createdAt: "2026-03-09T14:30:00Z",
      startedAt: "2026-03-09T14:30:01Z",
      completedAt: "2026-03-09T14:30:06Z",
    },
  ];

  context.mocks.data.team([createZeroAgent()]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.data.automations([
    createMockAutomationView({
      id: automationId,
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
      query.automationId === automationId
        ? runs.filter((run) => {
            return query.status === undefined || run.status === query.status;
          })
        : [];
    return respond(200, {
      data,
      pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
      filters: {
        statuses: ["completed", "failed"],
        sources: ["automation"],
        agents: [agentId],
      },
    });
  });
}

describe("zero automation detail page", () => {
  it("shows a removed automation state", async () => {
    context.mocks.data.team([createZeroAgent()]);
    context.mocks.data.automations([]);

    detachedSetupPage({ context, path: `/automations/${automationId}` });

    await waitFor(() => {
      expect(screen.getByText("Automation not found")).toBeInTheDocument();
      expect(
        screen.getByText("This automation does not exist or was removed."),
      ).toBeInTheDocument();
      expect(screen.getByText("Back to automations")).toBeInTheDocument();
    });
  });

  it("shows read-only automation details", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${automationId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

    expect(screen.getAllByText("Status").length).toBeGreaterThan(0);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.getByText("Every weekday at 2:30 PM")).toBeInTheDocument();
    expect(screen.getByText("Next run")).toBeInTheDocument();
    expect(screen.getByText("Run history")).toBeInTheDocument();
    expect(screen.queryByText("Danger zone")).not.toBeInTheDocument();
    expect(screen.queryByText("Run now")).not.toBeInTheDocument();
    expect(screen.queryByText("Delete automation")).not.toBeInTheDocument();
  });

  it("filters automation run history", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${automationId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
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
  });

  it("paginates automation run history", async () => {
    mockAutomationDetailStory();
    context.mocks.api(logsListContract.list, ({ query, respond }) => {
      const cursor = query.cursor ?? null;
      const startedAt =
        cursor === "page-2" ? "2026-03-10T14:35:01Z" : "2026-03-10T14:30:01Z";
      const completedAt =
        cursor === "page-2" ? "2026-03-10T14:35:03Z" : "2026-03-10T14:30:02Z";
      return respond(200, {
        data: [
          {
            id:
              cursor === "page-2"
                ? "a0000000-0000-4000-a000-000000000212"
                : "a0000000-0000-4000-a000-000000000211",
            sessionId:
              cursor === "page-2" ? "session-page-2" : "session-page-1",
            agentId,
            displayName: "Zero",
            framework: "claude-code",
            triggerSource: "automation",
            triggerAgentName: null,
            automationId,
            status: cursor === "page-2" ? "failed" : "completed",
            prompt: "Send morning brief to the team channel",
            createdAt: startedAt,
            startedAt,
            completedAt,
          },
        ],
        pagination: {
          hasMore: cursor !== "page-2",
          nextCursor: cursor === "page-2" ? null : "page-2",
          totalPages: 2,
        },
        filters: {
          statuses: ["completed", "failed"],
          sources: ["automation"],
          agents: [agentId],
        },
      });
    });

    detachedSetupPage({ context, path: `/automations/${automationId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("1.0s")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Next page"));

    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
      expect(screen.getByText("Failed")).toBeInTheDocument();
      expect(screen.getByText("2.0s")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Previous page"));

    await waitFor(() => {
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
      expect(screen.getByText("Done")).toBeInTheDocument();
      expect(screen.getByText("1.0s")).toBeInTheDocument();
    });
  });
});
