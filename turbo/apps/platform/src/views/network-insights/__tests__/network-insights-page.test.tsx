import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroInsightsContract,
  type InsightsResponse,
} from "@vm0/api-contracts/contracts/zero-insights";
import {
  zeroUsageInsightContract,
  type UsageInsightResponse,
} from "@vm0/api-contracts/contracts/zero-usage-insight";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup();

function localDateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((el) => {
    return el.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
}

function insightsResponse(): InsightsResponse {
  const date = localDateDaysAgo(1);
  return {
    days: [
      {
        date,
        agents: [
          {
            agentName: "Research Bot",
            agentId: "c0000000-0000-4000-a000-000000000001",
            runs: 9,
            credits: 1250,
          },
          {
            agentName: "Ops Bot",
            agentId: "c0000000-0000-4000-a000-000000000002",
            runs: 3,
            credits: 320,
          },
        ],
        creditsUsed: 1570,
        creditBalance: 8800,
        teamUsage: [
          {
            name: "Dana",
            credits: 1100,
            agentNames: ["Research Bot"],
            agentCredits: { "Research Bot": 1100 },
          },
          {
            name: "Lee",
            credits: 470,
            agentNames: ["Ops Bot"],
            agentCredits: { "Ops Bot": 470 },
          },
        ],
        topTask: { name: "market research", count: 5 },
        services: [
          {
            domain: "slack",
            calls: 12,
            agentNames: ["Research Bot"],
          },
          {
            domain: "github",
            calls: 4,
            agentNames: ["Ops Bot"],
          },
        ],
        permissions: [
          {
            label: "admin.analytics:read",
            connectorType: "slack",
            allowed: 7,
            denied: 0,
            agentNames: ["Research Bot"],
          },
          {
            label: "channels:read",
            connectorType: "slack",
            allowed: 5,
            denied: 0,
            agentNames: ["Research Bot"],
          },
          {
            label: "chat:write",
            connectorType: "slack",
            allowed: 4,
            denied: 0,
            agentNames: ["Research Bot"],
          },
          {
            label: "repo-read",
            connectorType: "github",
            allowed: 3,
            denied: 0,
            agentNames: ["Ops Bot"],
          },
          {
            label: "issues:read",
            connectorType: "github",
            allowed: 2,
            denied: 0,
            agentNames: ["Ops Bot"],
          },
          {
            label: "pull-requests:read",
            connectorType: "github",
            allowed: 1,
            denied: 0,
            agentNames: ["Ops Bot"],
          },
          {
            label: "admin.apps:write",
            connectorType: "slack",
            allowed: 0,
            denied: 3,
            agentNames: ["Research Bot"],
          },
        ],
        schedules: [
          {
            scheduleId: "d0000000-0000-4000-a000-000000000001",
            scheduleName: "Morning Briefing",
            scheduleDescription: "Daily market briefing",
            credits: 300,
            tokens: 600,
          },
          {
            scheduleId: "d0000000-0000-4000-a000-000000000002",
            scheduleName: "Lead Sync",
            scheduleDescription: null,
            credits: 250,
            tokens: 500,
          },
          {
            scheduleId: "d0000000-0000-4000-a000-000000000003",
            scheduleName: "CRM Sweep",
            scheduleDescription: null,
            credits: 200,
            tokens: 400,
          },
          {
            scheduleId: "d0000000-0000-4000-a000-000000000004",
            scheduleName: "Support Digest",
            scheduleDescription: null,
            credits: 150,
            tokens: 300,
          },
          {
            scheduleId: "d0000000-0000-4000-a000-000000000005",
            scheduleName: "Hidden Schedule",
            scheduleDescription: null,
            credits: 100,
            tokens: 200,
          },
        ],
        chats: [
          {
            threadId: "b0000000-0000-4000-a000-000000000001",
            threadTitle: "Competitor scan",
            credits: 120,
            tokens: 240,
          },
          {
            threadId: "b0000000-0000-4000-a000-000000000002",
            threadTitle: "Pricing notes",
            credits: 110,
            tokens: 220,
          },
          {
            threadId: "b0000000-0000-4000-a000-000000000003",
            threadTitle: "Partner follow-up",
            credits: 100,
            tokens: 200,
          },
          {
            threadId: "b0000000-0000-4000-a000-000000000004",
            threadTitle: "Launch memo",
            credits: 90,
            tokens: 180,
          },
          {
            threadId: "b0000000-0000-4000-a000-000000000005",
            threadTitle: "Hidden chat",
            credits: 80,
            tokens: 160,
          },
        ],
      },
    ],
    totalCredits: 1570,
    totalRuns: 12,
    lastUpdated: `${date}T18:30:00Z`,
  };
}

function usageInsightResponse(): UsageInsightResponse {
  return {
    buckets: [
      {
        ts: `${localDateDaysAgo(1)} 00:00:00`,
        series: { chat: 400, slack: 250 },
        tokens: { chat: 800, slack: 500 },
      },
    ],
    schedules: [
      {
        scheduleId: "d0000000-0000-4000-a000-000000000001",
        scheduleName: "Morning Briefing",
        scheduleDescription: null,
        credits: 300,
        tokens: 600,
      },
    ],
    scheduleOtherCount: 0,
    scheduleOtherCredits: 0,
    chats: [
      {
        threadId: "b0000000-0000-4000-a000-000000000001",
        threadTitle: "Competitor scan",
        credits: 120,
        tokens: 240,
      },
    ],
    chatOtherCount: 0,
    chatOtherCredits: 0,
    emailCredits: 0,
    emailTokens: 0,
    slackCredits: 250,
    slackTokens: 500,
    grandTotalCredits: 650,
    grandTotalTokens: 1300,
  };
}

describe("network insights page", () => {
  it("shows daily network insights and switches to the time range usage view", async () => {
    context.mocks.api(zeroInsightsContract.get, ({ query, respond }) => {
      expect(query.days).toBe(30);
      return respond(200, insightsResponse());
    });
    context.mocks.api(zeroUsageInsightContract.get, ({ respond }) => {
      return respond(200, usageInsightResponse());
    });

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Insights & Usage" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("Ops Bot")).toBeInTheDocument();
    expect(screen.getByText("admin.analytics:read")).toBeInTheDocument();
    expect(screen.getByText("3 rejected")).toBeInTheDocument();
    expect(screen.getByText("Daily market briefing")).toBeInTheDocument();
    expect(screen.getByText("Competitor scan")).toBeInTheDocument();

    expect(screen.queryByText("pull-requests:read")).not.toBeInTheDocument();
    click(screen.getByText("Load more"));
    await waitFor(() => {
      expect(screen.getByText("pull-requests:read")).toBeInTheDocument();
    });

    expect(screen.queryByText("Hidden Schedule")).not.toBeInTheDocument();
    await user.click(screen.getByText("+1 more schedule"));
    expect(screen.getByText("Hidden Schedule")).toBeInTheDocument();

    expect(screen.queryByText("Hidden chat")).not.toBeInTheDocument();
    await user.click(screen.getByText("+1 more chat"));
    expect(screen.getByText("Hidden chat")).toBeInTheDocument();

    click(getTabByText("Time range"));

    await waitFor(() => {
      expect(screen.getByText("Morning Briefing")).toBeInTheDocument();
    });
    expect(screen.getByText("Competitor scan")).toBeInTheDocument();
    expect(screen.getByText("650")).toBeInTheDocument();
  });
});
