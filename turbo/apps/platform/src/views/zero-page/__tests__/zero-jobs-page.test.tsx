import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  setMockSchedules,
  createMockScheduleResponse,
} from "../../../mocks/handlers/api-schedules.ts";
import type { ScheduleResponse } from "@vm0/core/contracts/zero-schedules";

const context = testContext();

function createMockTeamWithSubagents() {
  return [
    {
      id: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-2",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
    {
      id: "agent-3",
      displayName: null,
      description: "Writes content based on research",
      sound: null,
      avatarUrl: null,
      headVersionId: "version_3",
      updatedAt: "2024-01-03T00:00:00Z",
    },
  ];
}

function mockTeamAPI(
  agents: {
    id: string;
    displayName: string | null;
    description: string | null;
    sound: null;
    avatarUrl: null;
    headVersionId: string;
    updatedAt: string;
  }[] = createMockTeamWithSubagents(),
) {
  setMockTeam(agents);
}

function renderTeamPage() {
  detachedSetupPage({ context, path: "/agents" });
}

describe("zero jobs page - team list", () => {
  it("should render team page with main agent and sub-agents", async () => {
    mockTeamAPI();
    await renderTeamPage();

    // Verify sub-agents render with correct names (including displayName fallback)
    await waitFor(() => {
      expect(screen.getByText("Research Agent")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Finds and summarizes information"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Writes content based on research"),
    ).toBeInTheDocument();
    // "writer" agent has displayName: null, so it should fall back to showing the id
    expect(screen.getByText("agent-3")).toBeInTheDocument();
  });

  it("should show new agent button when no sub-agents exist", async () => {
    mockTeamAPI([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("New agent")).toBeInTheDocument();
    });
  });

  it("should show new agent button when sub-agents exist", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("New agent")).toBeInTheDocument();
    });
  });

  it("should display multiple agents when team API returns multiple agents", async () => {
    mockTeamAPI([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "agent-alpha",
        displayName: "Alpha Agent",
        description: "Handles alpha tasks",
        sound: null,
        avatarUrl: null,
        headVersionId: "version_a",
        updatedAt: "2024-01-02T00:00:00Z",
      },
      {
        id: "agent-beta",
        displayName: "Beta Agent",
        description: "Handles beta tasks",
        sound: null,
        avatarUrl: null,
        headVersionId: "version_b",
        updatedAt: "2024-01-03T00:00:00Z",
      },
      {
        id: "agent-gamma",
        displayName: "Gamma Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        headVersionId: "version_g",
        updatedAt: "2024-01-04T00:00:00Z",
      },
    ]);
    await renderTeamPage();

    // All three sub-agents should be visible (default agent is filtered out)
    await waitFor(() => {
      expect(screen.getByText("Alpha Agent")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Agent")).toBeInTheDocument();
    expect(screen.getByText("Gamma Agent")).toBeInTheDocument();

    // Descriptions should be visible where provided
    expect(screen.getByText("Handles alpha tasks")).toBeInTheDocument();
    expect(screen.getByText("Handles beta tasks")).toBeInTheDocument();
  });
});

function createMockSchedulesFromAPI(): ScheduleResponse[] {
  return [
    createMockScheduleResponse({
      id: "f0000002-0000-4000-a000-000000000001",
      displayName: null,
      userId: "user_test1",
      name: "zero-morning",
      cronExpression: "55 9 * * 1-5",
      timezone: "Asia/Shanghai",
      prompt: "Send morning brief pptx to the team channel",
      description: "Morning brief",
      nextRunAt: "2026-03-26T01:55:00.000Z",
      lastRunAt: "2026-03-25T01:55:22.168Z",
      createdAt: "2026-03-18T06:30:22.322Z",
      updatedAt: "2026-03-24T13:47:09.003Z",
    }),
    createMockScheduleResponse({
      id: "f0000002-0000-4000-a000-000000000002",
      displayName: null,
      userId: "user_test1",
      name: "zero-ac",
      timezone: "Asia/Shanghai",
      prompt: "Turn on the air conditioning in my office",
      description: "Office AC on",
      nextRunAt: "2026-03-26T01:00:00.000Z",
      lastRunAt: "2026-03-25T01:00:27.774Z",
      createdAt: "2026-03-20T02:58:38.749Z",
      updatedAt: "2026-03-25T01:46:27.637Z",
    }),
    createMockScheduleResponse({
      id: "f0000002-0000-4000-a000-000000000003",
      displayName: null,
      userId: "user_test1",
      name: "zero-evening",
      cronExpression: "0 19 * * 1-5",
      timezone: "Asia/Shanghai",
      prompt:
        "Summarize today's work and post evening brief to the team channel",
      description: "Evening work summary",
      nextRunAt: "2026-03-25T11:00:00.000Z",
      createdAt: "2026-03-24T13:44:56.808Z",
      updatedAt: "2026-03-24T13:47:30.669Z",
    }),
  ];
}

function mockScheduleAPI(schedules = createMockSchedulesFromAPI()) {
  setMockSchedules(schedules);
}

function renderSchedulePage() {
  detachedSetupPage({ context, path: "/schedules" });
}

describe("zero jobs page - schedule list", () => {
  it("should display multiple schedules when schedule API returns data", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    // All three schedules should be visible (description is shown when available)
    await waitFor(() => {
      expect(screen.getAllByText("Morning brief")[0]).toBeInTheDocument();
    });
    expect(screen.getAllByText("Office AC on")[0]).toBeInTheDocument();
    expect(screen.getAllByText("Evening work summary")[0]).toBeInTheDocument();
  });
});
