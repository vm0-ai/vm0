import { fireEvent, screen, waitFor } from "@testing-library/react";
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
import type { NetworkInsightsData } from "../../../signals/network-insights/network-insights-signals.ts";

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

function monthYearLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function shortDateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function monthsBetweenTodayAnd(iso: string): number {
  const today = new Date();
  const target = new Date(`${iso}T00:00:00`);
  return (
    (today.getFullYear() - target.getFullYear()) * 12 +
    today.getMonth() -
    target.getMonth()
  );
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

function insightsResponse(): InsightsResponse & NetworkInsightsData {
  const date = localDateDaysAgo(1);
  const olderDate = localDateDaysAgo(20);
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
            userId: "test-user-123",
            name: "Dana",
            credits: 1100,
            agentNames: ["Research Bot"],
            agentCredits: { "Research Bot": 1100 },
          },
          {
            userId: "test-user-456",
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
      {
        date: olderDate,
        agents: [
          {
            agentName: "Archive Bot",
            agentId: "c0000000-0000-4000-a000-000000000003",
            runs: 1,
            credits: 80,
          },
        ],
        creditsUsed: 80,
        creditBalance: 8720,
        teamUsage: [
          {
            userId: "test-user-789",
            name: "Mira",
            credits: 80,
            agentNames: ["Archive Bot"],
            agentCredits: { "Archive Bot": 80 },
          },
        ],
        topTask: { name: "calendar cleanup", count: 1 },
        services: [
          {
            domain: "google-calendar",
            calls: 2,
            agentNames: ["Archive Bot"],
          },
        ],
        permissions: [
          {
            label: "events:read",
            connectorType: "google-calendar",
            allowed: 2,
            denied: 0,
            agentNames: ["Archive Bot"],
          },
        ],
        schedules: [],
        chats: [],
      },
    ],
    totalCredits: 1650,
    totalRuns: 13,
    lastUpdated: `${date}T18:30:00Z`,
  };
}

function oldInsightsResponse(): InsightsResponse & NetworkInsightsData {
  const data = insightsResponse();
  return {
    ...data,
    days: [
      {
        ...data.days[0]!,
        date: localDateDaysAgo(40),
      },
    ],
    lastUpdated: null,
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
  it("shows an empty daily insights state", async () => {
    context.mocks.api(zeroInsightsContract.get, ({ respond }) => {
      return respond(200, {
        days: [],
        totalCredits: 0,
        totalRuns: 0,
        lastUpdated: null,
      });
    });

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Insights & Usage" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Run an agent to see insights here."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Daily breakdown")).not.toBeInTheDocument();
    expect(screen.queryByText("Time range")).not.toBeInTheDocument();
  });

  it("shows daily network insights and switches to the time range usage view", async () => {
    context.mocks.api(zeroInsightsContract.get, ({ respond }) => {
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
    expect(screen.queryByText("Archive Bot")).not.toBeInTheDocument();

    const researchAgent = screen.getByText("Research Bot");
    fireEvent.mouseEnter(researchAgent);
    await waitFor(() => {
      expect(screen.getAllByText("by Research Bot").length).toBeGreaterThan(0);
    });
    fireEvent.mouseLeave(researchAgent);
    await waitFor(() => {
      expect(screen.queryAllByText("by Research Bot")).toHaveLength(0);
    });

    click(screen.getByText("Last 7 Days"));
    click(screen.getByText("Last 28 Days"));

    await waitFor(() => {
      expect(screen.getByText("Archive Bot")).toBeInTheDocument();
    });

    click(screen.getByText("Last 28 Days"));
    click(screen.getByText("Last 7 Days"));

    await waitFor(() => {
      expect(screen.queryByText("Archive Bot")).not.toBeInTheDocument();
    });

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

  it("shows a no-activity message when the selected range excludes older data", async () => {
    context.mocks.api(zeroInsightsContract.get, ({ respond }) => {
      return respond(200, oldInsightsResponse());
    });

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByText("No activity in this time range."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    expect(screen.queryByText("Research Bot")).not.toBeInTheDocument();
  });

  it("filters the daily insights view to a custom calendar day", async () => {
    const customDate = localDateDaysAgo(20);
    context.mocks.api(zeroInsightsContract.get, ({ respond }) => {
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
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.queryByText("Archive Bot")).not.toBeInTheDocument();

    click(screen.getByText("Last 7 Days"));
    click(screen.getByText("Custom Range"));

    const monthsBack = monthsBetweenTodayAnd(customDate);
    for (let i = 0; i < monthsBack; i++) {
      const currentMonth = new Date();
      currentMonth.setMonth(currentMonth.getMonth() - i);
      const currentLabel = currentMonth.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
      const monthHeader = screen.getByText(currentLabel).closest("div");
      if (!monthHeader) {
        throw new Error(`Could not find calendar header: ${currentLabel}`);
      }
      const previousButton = queryAllByRoleFast("button", monthHeader)[0];
      if (!previousButton) {
        throw new Error(
          `Could not find previous month button: ${currentLabel}`,
        );
      }
      click(previousButton);
    }

    const targetLabel = monthYearLabel(customDate);
    await waitFor(() => {
      expect(screen.getByText(targetLabel)).toBeInTheDocument();
    });

    const calendarContent =
      screen
        .getByText(targetLabel)
        .closest("[data-radix-popper-content-wrapper]") ??
      screen.getByText(targetLabel).parentElement?.parentElement;
    if (!calendarContent) {
      throw new Error(`Could not find calendar content: ${targetLabel}`);
    }
    const dayLabel = String(Number(customDate.slice(8, 10)));
    const dayButton = queryAllByRoleFast("button", calendarContent).find(
      (button) => {
        return button.textContent?.trim() === dayLabel;
      },
    );
    if (!dayButton) {
      throw new Error(`Could not find custom date button: ${customDate}`);
    }
    click(dayButton);

    await waitFor(() => {
      expect(screen.getByText(shortDateLabel(customDate))).toBeInTheDocument();
    });
    expect(screen.getByText("Archive Bot")).toBeInTheDocument();
    expect(screen.getByText("Mira")).toBeInTheDocument();
    expect(screen.queryByText("Research Bot")).not.toBeInTheDocument();
    expect(screen.queryByText("Morning Briefing")).not.toBeInTheDocument();
  });
});
