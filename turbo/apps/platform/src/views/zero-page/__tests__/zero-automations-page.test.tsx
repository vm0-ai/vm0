import { screen, waitFor } from "@testing-library/react";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { automationsMainContract } from "@vm0/api-contracts/contracts/automations";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { toMockAutomationResponse } from "../../../mocks/handlers/api-automations.ts";
import { createMockAutomationView } from "../../../mocks/handlers/automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const zeroAgentId = "c0000000-0000-4000-a000-000000000001";
const researchAgentId = "a0000000-0000-4000-a000-000000000301";

function createAgent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2026-03-10T00:00:00Z",
  };
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

function mockAutomationsPageStory(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.data.automations([
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000301",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "weekday-morning-brief",
      cronExpression: "30 14 * * 1-5",
      timezone: "UTC",
      prompt: "Send morning brief to the team channel",
      description: "Morning brief",
      enabled: true,
    }),
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000302",
      agentId: researchAgentId,
      displayName: "Research Agent",
      name: "office-climate-loop",
      triggerType: "loop",
      cronExpression: null,
      intervalSeconds: 2700,
      timezone: "UTC",
      prompt: "Turn on the air conditioning in my office",
      description: "Office AC",
      enabled: true,
    }),
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000303",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "monthly-billing-audit",
      cronExpression: "15 16 12 * *",
      timezone: "UTC",
      prompt: "Review monthly billing anomalies",
      description: "Billing audit",
      enabled: true,
    }),
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000304",
      agentId: researchAgentId,
      displayName: "Research Agent",
      name: "launch-readiness-check",
      triggerType: "once",
      cronExpression: null,
      atTime: "2026-06-12T18:45:00Z",
      timezone: "UTC",
      prompt: "Run the launch readiness checklist",
      description: "Release checklist",
      enabled: true,
    }),
  ]);
}

function mockEmptyAutomationsStory(): void {
  context.mocks.data.team([
    createAgent(zeroAgentId, "Zero"),
    createAgent(researchAgentId, "Research Agent"),
  ]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.data.automations([]);
}

function mockAutomationListEdgeStory(): void {
  context.mocks.data.team([createAgent(zeroAgentId, "Zero")]);
  context.mocks.data.userPreferences({ timezone: "UTC" });
  context.mocks.data.automations([
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000305",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "disabled-escalation-review",
      cronExpression: "7 9 * * 1-5",
      timezone: "UTC",
      prompt: "Review overnight escalations",
      description: null,
      enabled: false,
    }),
  ]);
}

function mockShanghaiEveningSchedule(): void {
  context.mocks.data.team([createAgent(zeroAgentId, "Zero")]);
  context.mocks.data.userPreferences({ timezone: "Asia/Shanghai" });
  context.mocks.data.automations([
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000307",
      agentId: zeroAgentId,
      displayName: "Zero",
      name: "shanghai-evening-sync",
      cronExpression: "0 19 * * *",
      timezone: "Asia/Shanghai",
      prompt: "Send the Shanghai evening sync",
      description: "Shanghai evening sync",
      enabled: true,
    }),
  ]);
}

async function openAutomationsPage(): Promise<void> {
  detachedSetupPage({ context, path: "/automations" });

  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Automations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });
}

async function openAutomationList(): Promise<void> {
  await openAutomationsPage();
  click(tabByText("List"));

  await waitFor(() => {
    expect(screen.getByText("Instruction")).toBeInTheDocument();
    expect(screen.getByText("Runs at")).toBeInTheDocument();
  });
}

describe("zero automations page", () => {
  it("keeps the legacy automations page available as read-only history", async () => {
    mockAutomationsPageStory();

    detachedSetupPage({
      context,
      path: "/automations",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Automations" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("Legacy scheduled automations in your workspace."),
    ).toBeInTheDocument();
    expect(screen.getByText("Calendar")).toBeInTheDocument();
    expect(screen.getByText("List")).toBeInTheDocument();
    expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
    expect(screen.queryByText("Add automation")).not.toBeInTheDocument();
  });

  it("opens legacy automation detail paths", async () => {
    mockAutomationsPageStory();

    detachedSetupPage({
      context,
      path: "/automations/f0000001-0000-4000-a000-000000000301",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Morning brief" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Run history")).toBeInTheDocument();
    expect(screen.getByText("Every weekday at 2:30 PM")).toBeInTheDocument();
    expect(screen.queryByText("Settings")).not.toBeInTheDocument();
  });

  it("shows scheduled work in the calendar", async () => {
    mockAutomationsPageStory();

    await openAutomationsPage();

    expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(screen.getByText("Monthly")).toBeInTheDocument();
    expect(screen.getByText("Once")).toBeInTheDocument();
    expect(
      screen.getByText("Every month on day 12 at 4:15 PM"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Once on 2026-06-12 at 6:45 PM"),
    ).toBeInTheDocument();
  });

  it("keeps GMT+8 saved schedule time in the calendar after refresh", async () => {
    mockShanghaiEveningSchedule();

    await openAutomationsPage();

    expect(screen.getAllByText("7:00 PM")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Shanghai evening sync")[0]).toBeInTheDocument();
    expect(screen.queryByText("3:00 AM")).not.toBeInTheDocument();
  });

  it("shows scheduled work in the list", async () => {
    mockAutomationsPageStory();

    await openAutomationList();

    expect(screen.getAllByText("Research Agent")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Office AC")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every 45 minutes")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Billing audit")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Release checklist")[0]).toBeInTheDocument();
    expect(
      screen.getAllByText("Every month on day 12 at 4:15 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Once on 2026-06-12 at 6:45 PM")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByLabelText(
        "Open automation Send morning brief to the team channel",
      )[0],
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Disable/u)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/More actions/u)).not.toBeInTheDocument();
  });

  it("keeps GMT+8 saved schedule time in the list after refresh", async () => {
    mockShanghaiEveningSchedule();

    await openAutomationList();

    expect(screen.getAllByText("Shanghai evening sync")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Every day at 7:00 PM")[0]).toBeInTheDocument();
    expect(screen.queryByText("Every day at 3:00 AM")).not.toBeInTheDocument();
  });

  it("shows read-only empty list copy", async () => {
    mockEmptyAutomationsStory();

    await openAutomationsPage();
    click(tabByText("List"));

    await waitFor(() => {
      expect(screen.getByText("No upcoming runs")).toBeInTheDocument();
      expect(
        screen.getByText("Legacy scheduled automations will appear here."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Add automation")).not.toBeInTheDocument();
  });

  it("keeps the list loading state visible until automations resolve", async () => {
    context.mocks.data.team([
      createAgent(zeroAgentId, "Zero"),
      createAgent(researchAgentId, "Research Agent"),
    ]);
    context.mocks.data.userPreferences({ timezone: "UTC" });

    const automationsReady = context.mocks.deferred<void>();

    context.mocks.api(automationsMainContract.list, async ({ respond }) => {
      await automationsReady.promise;
      return respond(200, {
        automations: [
          toMockAutomationResponse(
            createMockAutomationView({
              id: "f0000001-0000-4000-a000-000000000306",
              agentId: researchAgentId,
              displayName: "Research Agent",
              name: "launch-loading-check",
              cronExpression: "45 17 * * 1-5",
              timezone: "UTC",
              prompt: "Check launch risks before standup",
              description: "Launch loading check",
              enabled: true,
            }),
          ),
        ],
      });
    });

    detachedSetupPage({ context, path: "/automations" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Automations" }),
      ).toBeInTheDocument();
    });
    click(tabByText("List"));

    await waitFor(() => {
      expect(
        screen.getByTestId("automation-list-skeleton"),
      ).toBeInTheDocument();
    });

    automationsReady.resolve();

    await waitFor(() => {
      expect(
        screen.queryByTestId("automation-list-skeleton"),
      ).not.toBeInTheDocument();
      expect(
        screen.getAllByText("Launch loading check").length,
      ).toBeGreaterThan(0);
      expect(
        screen.getAllByText("Every weekday at 5:45 PM").length,
      ).toBeGreaterThan(0);
    });
  });

  it("opens disabled prompt-only automations from list rows", async () => {
    mockAutomationListEdgeStory();

    await openAutomationList();

    expect(
      screen.getAllByText("Review overnight escalations")[0],
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Every weekday at 9:07 AM")[0],
    ).toBeInTheDocument();

    click(
      screen.getAllByLabelText(
        "Open automation Review overnight escalations",
      )[0],
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Review overnight escalations" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });
});
