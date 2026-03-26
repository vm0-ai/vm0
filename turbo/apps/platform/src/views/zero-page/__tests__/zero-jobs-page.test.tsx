import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function createMockTeamWithSubagents() {
  return [
    {
      id: "mock-compose-id",
      displayName: null,
      description: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "agent-2",
      displayName: "Research Agent",
      description: "Finds and summarizes information",
      headVersionId: "version_2",
      updatedAt: "2024-01-02T00:00:00Z",
    },
    {
      id: "agent-3",
      displayName: null,
      description: "Writes content based on research",
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
    headVersionId: string;
    updatedAt: string;
  }[] = createMockTeamWithSubagents(),
) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json(agents);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

function mockTeamAPIError() {
  server.use(
    http.get("*/api/zero/team", () => {
      return new HttpResponse(null, {
        status: 500,
        statusText: "Internal Server Error",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderTeamPage() {
  await setupPage({ context, path: "/team" });
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

  it("should show create teammate button when no sub-agents exist", async () => {
    mockTeamAPI([
      {
        id: "mock-compose-id",
        displayName: null,
        description: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Create teammate")).toBeInTheDocument();
    });
  });

  it("should show create teammate button when sub-agents exist", async () => {
    mockTeamAPI();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Create teammate")).toBeInTheDocument();
    });
  });

  it("should display multiple agents when team API returns multiple agents", async () => {
    mockTeamAPI([
      {
        id: "mock-compose-id",
        displayName: null,
        description: null,
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "agent-alpha",
        displayName: "Alpha Agent",
        description: "Handles alpha tasks",
        headVersionId: "version_a",
        updatedAt: "2024-01-02T00:00:00Z",
      },
      {
        id: "agent-beta",
        displayName: "Beta Agent",
        description: "Handles beta tasks",
        headVersionId: "version_b",
        updatedAt: "2024-01-03T00:00:00Z",
      },
      {
        id: "agent-gamma",
        displayName: "Gamma Agent",
        description: null,
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

  it("should show error state with retry link when API fails", async () => {
    mockTeamAPIError();
    await renderTeamPage();

    await waitFor(() => {
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });
});

function createMockSchedulesFromAPI() {
  return [
    {
      id: "sched-a1b2c3",
      agentId: "mock-compose-id",
      agentName: "test-agent",
      orgSlug: "test",
      userId: "user_test1",
      name: "zero-morning",
      triggerType: "cron",
      cronExpression: "55 9 * * 1-5",
      atTime: null,
      intervalSeconds: null,
      timezone: "Asia/Shanghai",
      prompt: "Send morning brief pptx to the team channel",
      description: "Morning brief",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      enabled: true,
      notifyEmail: false,
      notifySlack: false,
      slackChannelId: null,
      nextRunAt: "2026-03-26T01:55:00.000Z",
      lastRunAt: "2026-03-25T01:55:22.168Z",
      retryStartedAt: null,
      consecutiveFailures: 0,
      createdAt: "2026-03-18T06:30:22.322Z",
      updatedAt: "2026-03-24T13:47:09.003Z",
    },
    {
      id: "sched-d4e5f6",
      agentId: "mock-compose-id",
      agentName: "test-agent",
      orgSlug: "test",
      userId: "user_test1",
      name: "zero-ac",
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
      atTime: null,
      intervalSeconds: null,
      timezone: "Asia/Shanghai",
      prompt: "Turn on the air conditioning in my office",
      description: "Office AC on",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      enabled: true,
      notifyEmail: false,
      notifySlack: false,
      slackChannelId: null,
      nextRunAt: "2026-03-26T01:00:00.000Z",
      lastRunAt: "2026-03-25T01:00:27.774Z",
      retryStartedAt: null,
      consecutiveFailures: 0,
      createdAt: "2026-03-20T02:58:38.749Z",
      updatedAt: "2026-03-25T01:46:27.637Z",
    },
    {
      id: "sched-g7h8i9",
      agentId: "mock-compose-id",
      agentName: "test-agent",
      orgSlug: "test",
      userId: "user_test1",
      name: "zero-evening",
      triggerType: "cron",
      cronExpression: "0 19 * * 1-5",
      atTime: null,
      intervalSeconds: null,
      timezone: "Asia/Shanghai",
      prompt:
        "Summarize today's work and post evening brief to the team channel",
      description: "Evening work summary",
      appendSystemPrompt: null,
      vars: null,
      secretNames: null,
      artifactName: null,
      artifactVersion: null,
      volumeVersions: null,
      enabled: true,
      notifyEmail: false,
      notifySlack: false,
      slackChannelId: null,
      nextRunAt: "2026-03-25T11:00:00.000Z",
      lastRunAt: null,
      retryStartedAt: null,
      consecutiveFailures: 0,
      createdAt: "2026-03-24T13:44:56.808Z",
      updatedAt: "2026-03-24T13:47:30.699Z",
    },
  ];
}

function mockScheduleAPI(schedules = createMockSchedulesFromAPI()) {
  server.use(
    http.get("*/api/zero/schedules", () => {
      return HttpResponse.json({ schedules });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );
}

async function renderSchedulePage() {
  await setupPage({ context, path: "/schedule" });
}

describe("zero jobs page - schedule list", () => {
  it("should display multiple schedules when schedule API returns data", async () => {
    mockScheduleAPI();
    await renderSchedulePage();

    // All three schedules should be visible (description is shown when available)
    await waitFor(() => {
      expect(screen.getByText("Morning brief")).toBeInTheDocument();
    });
    expect(screen.getByText("Office AC on")).toBeInTheDocument();
    expect(screen.getByText("Evening work summary")).toBeInTheDocument();
  });
});
