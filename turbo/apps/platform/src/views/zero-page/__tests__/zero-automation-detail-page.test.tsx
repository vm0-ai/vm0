import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  logsListContract,
  type LogsListResponse,
} from "@vm0/api-contracts/contracts/logs";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockAutomationView } from "../../../mocks/handlers/automations-store.ts";
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

function normalizeText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function selectOptionByLabel(
  label: string,
  option: string | RegExp,
  container: HTMLElement = document.body,
): void {
  click(within(container).getByLabelText(label));
  click(screen.getByRole("option", { name: option }));
}

function selectTimeComboboxByIndex(index: number, option: string): void {
  const trigger = screen.getAllByRole("combobox").filter((candidate) => {
    return /^\d{2}$/u.test(normalizeText(candidate));
  })[index];
  if (!trigger) {
    throw new Error(`time combobox ${index} not found`);
  }
  click(trigger);
  click(screen.getByRole("option", { name: option }));
}

function expectTextPresent(text: string | RegExp): void {
  expect(
    screen.getAllByText(text).some((element) => {
      return normalizeText(element).length > 0;
    }),
  ).toBeTruthy();
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
      scheduleId,
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
      scheduleId,
      status: "failed",
      prompt: "Send morning brief to the team channel",
      createdAt: "2026-03-09T14:30:00Z",
      startedAt: "2026-03-09T14:30:01Z",
      completedAt: "2026-03-09T14:30:06Z",
    },
  ];

  context.mocks.data.team([createZeroAgent()]);
  context.mocks.data.automations([
    createMockAutomationView({
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

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(screen.getByText("Automation not found")).toBeInTheDocument();
      expect(
        screen.getByText("This automation doesn't exist or was removed."),
      ).toBeInTheDocument();
      expect(screen.getByText("Back to automations")).toBeInTheDocument();
    });
  });

  it("edits and discards automation instructions", async () => {
    const user = userEvent.setup({ delay: null });
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

    click(tabByText("Instructions"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "This instruction runs each time this automation executes.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Send morning brief to the team channel"),
      ).toBeInTheDocument();
    });

    const editor = document.querySelector('[contenteditable="true"]');
    if (!(editor instanceof HTMLElement)) {
      throw new Error("automation instructions editor not found");
    }

    await user.click(editor);
    await user.keyboard("{Control>}a{/Control}Send a concise launch brief");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(buttonByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Send morning brief to the team channel"),
      ).toBeInTheDocument();
    });

    const resetEditor = document.querySelector('[contenteditable="true"]');
    if (!(resetEditor instanceof HTMLElement)) {
      throw new Error("reset automation instructions editor not found");
    }

    await user.click(resetEditor);
    await user.keyboard("{Control>}a{/Control}Send a concise launch brief");

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(buttonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Automation updated")).toBeInTheDocument();
      expect(
        screen.getByText("Send a concise launch brief"),
      ).toBeInTheDocument();
    });
  });

  it("discards automation settings changes", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expectTextPresent(/Every weekday/u);
    expect(screen.getByText("Danger zone")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Morning brief"), {
      target: { value: "Draft update" },
    });

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(buttonByText("Discard"));

    await waitFor(() => {
      expect(
        screen.queryByText("You have unsaved changes"),
      ).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("Morning brief")).toBeInTheDocument();
    });
  });

  it("updates automation schedule settings", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByDisplayValue("Morning brief"), {
      target: { value: "Team morning brief" },
    });

    selectOptionByLabel("Time", "Loop");

    await waitFor(() => {
      expect(screen.getByText("Every")).toBeInTheDocument();
      expect(screen.getByText("15 minutes")).toBeInTheDocument();
    });

    selectOptionByLabel("Every", "60 minutes");
    expect(screen.getByText("60 minutes")).toBeInTheDocument();

    selectOptionByLabel("Time", "Once");
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2099-06-12" },
    });
    expect(screen.getByDisplayValue("2099-06-12")).toBeInTheDocument();
    selectTimeComboboxByIndex(0, "16");
    selectTimeComboboxByIndex(1, "45");
    selectOptionByLabel(
      "Timezone",
      /^\(GMT[+-]\d{2}:\d{2}\) Eastern Time \(ET\)$/u,
    );
    expect(screen.getByText(/Eastern Time \(ET\)/u)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
    });

    click(buttonByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Automation updated")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue(/Team morning brief/u)).toBeInTheDocument();
  });

  it("filters automation run history", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

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

    await waitFor(() => {
      expect(screen.getByText("Danger zone")).toBeInTheDocument();
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
            scheduleId,
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

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

    click(tabByText("Run History"));

    await waitFor(() => {
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

  it("pauses an automation and cancels deletion", async () => {
    const user = userEvent.setup({ delay: null });
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();

    click(screen.getByLabelText("Disable this automation"));

    await waitFor(() => {
      expect(screen.getByText("Paused")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Enable this automation")).toBeInTheDocument();

    click(buttonByText("Delete automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(screen.getByText("Delete automation?")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByText("Delete automation?")).not.toBeInTheDocument();
    });

    click(buttonByText("Delete automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    click(buttonByText("Cancel"));

    await waitFor(() => {
      expect(screen.queryByText("Delete automation?")).not.toBeInTheDocument();
    });
  });

  it("runs and deletes an automation", async () => {
    mockAutomationDetailStory();

    detachedSetupPage({ context, path: `/automations/${scheduleId}` });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });

    click(buttonByText("Run now"));

    await waitFor(() => {
      expect(screen.getByText(/Run started/u)).toBeInTheDocument();
      expect(screen.getByText("View activity")).toBeInTheDocument();
    });

    click(buttonByText("Delete automation"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    click(buttonByText("Delete"));

    await waitFor(() => {
      expect(screen.getByText("Automation deleted")).toBeInTheDocument();
      // Deletion returns to the automations surface, which renders the
      // Automations product noun now that the switch is globally on (#17307).
      expect(
        screen.getByRole("heading", { name: "Automations" }),
      ).toBeInTheDocument();
    });
  });
});
