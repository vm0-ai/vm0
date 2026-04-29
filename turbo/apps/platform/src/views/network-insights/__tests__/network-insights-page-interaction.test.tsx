/**
 * Interaction tests for the Network Insights page.
 *
 * Covers rendering insight cards, date range filtering, empty states,
 * and agent hover interactions.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroInsightsContract,
  type InsightsResponse,
} from "@vm0/api-contracts/contracts/zero-insights";
import { zeroUsageInsightContract } from "@vm0/api-contracts/contracts/zero-usage-insight";
import { usageInsightFixture } from "../../usage-page/__tests__/test-fixtures.ts";

const context = testContext();
const mockApi = createMockApi(context);

function daysAgoIso(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Pre-compute at package scope to satisfy ccstate/computed-const-args-package-scope
const day1Ago = daysAgoIso(1);
const day2Ago = daysAgoIso(2);
const day20Ago = daysAgoIso(20);
const day25Ago = daysAgoIso(25);

function mockInsightsAPI(days: InsightsResponse["days"] = []) {
  const totalCredits = days.reduce((s, d) => {
    return s + (d.creditsUsed ?? 0);
  }, 0);
  const totalRuns = days.reduce((s, d) => {
    return (
      s +
      (d.agents ?? []).reduce((rs, a) => {
        return rs + (a.runs ?? 0);
      }, 0)
    );
  }, 0);
  const lastUpdated = days.length > 0 ? new Date().toISOString() : null;
  server.use(
    mockApi(zeroInsightsContract.get, ({ respond }) => {
      return respond(200, { days, totalCredits, totalRuns, lastUpdated });
    }),
  );
}

function sampleDay(
  date: string,
  overrides?: Partial<InsightsResponse["days"][0]>,
): InsightsResponse["days"][0] {
  return {
    date,
    agents: [
      { agentName: "Alpha Bot", agentId: "a-1", runs: 5, credits: 120 },
      { agentName: "Beta Bot", agentId: "a-2", runs: 3, credits: 80 },
    ],
    creditsUsed: 200,
    creditBalance: 9800,
    teamUsage: [
      {
        name: "alice",
        credits: 120,
        agentNames: ["Alpha Bot"],
        agentCredits: { "Alpha Bot": 120 },
      },
      {
        name: "bob",
        credits: 80,
        agentNames: ["Beta Bot"],
        agentCredits: { "Beta Bot": 80 },
      },
    ],
    topTask: { name: "chat:write", count: 15 },
    services: [
      {
        domain: "slack",
        calls: 10,
        agentNames: ["Alpha Bot"],
      },
      {
        domain: "github",
        calls: 5,
        agentNames: ["Beta Bot"],
      },
    ],
    permissions: [
      {
        label: "chat:write",
        connectorType: "slack",
        allowed: 8,
        denied: 2,
        agentNames: ["Alpha Bot"],
      },
      {
        label: "github",
        connectorType: "github",
        allowed: 5,
        denied: 0,
        agentNames: ["Beta Bot"],
      },
    ],
    schedules: [],
    chats: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("network insights page - empty state", () => {
  it("should show empty message when no data", async () => {
    mockInsightsAPI([]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByText("Run an agent to see insights here."),
      ).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Data rendering
// ---------------------------------------------------------------------------

describe("network insights page - data rendering", () => {
  it("should render the Insights & Usage heading", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Insights & Usage")).toBeInTheDocument();
    });
  });

  it("should display last updated timestamp", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/Last updated/)).toBeInTheDocument();
    });
  });

  it("should display agent names from the data", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Alpha Bot")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Bot")).toBeInTheDocument();
  });

  it("should display credit amount", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("200")).toBeInTheDocument();
    });
  });

  it("should abbreviate credit amounts >= 1,000 with K suffix", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        creditsUsed: 12_400,
        creditBalance: 9500,
        teamUsage: [
          {
            name: "alice",
            credits: 12_400,
            agentNames: ["Alpha Bot"],
            agentCredits: { "Alpha Bot": 12_400 },
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getAllByText("12.4 K").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("9.5 K")).toBeInTheDocument();
  });

  it("should abbreviate credit amounts >= 1,000,000 with M suffix", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        creditsUsed: 2_300_000,
        creditBalance: 5_000_000,
        teamUsage: [
          {
            name: "alice",
            credits: 2_300_000,
            agentNames: ["Alpha Bot"],
            agentCredits: { "Alpha Bot": 2_300_000 },
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getAllByText("2.3 M").length).toBeGreaterThan(0);
    });
    expect(screen.getByText("5.0 M")).toBeInTheDocument();
  });

  it("should expose exact credit value via title attribute on hover", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        creditsUsed: 12_400,
        creditBalance: 9500,
        teamUsage: [
          {
            name: "alice",
            credits: 12_400,
            agentNames: ["Alpha Bot"],
            agentCredits: { "Alpha Bot": 12_400 },
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getAllByText("12.4 K").length).toBeGreaterThan(0);
    });
    // Hover tooltip via native title attribute exposes the exact value.
    const abbreviated = screen.getAllByText("12.4 K");
    expect(abbreviated[0]).toHaveAttribute("title", "12,400");
  });

  it("should render the Services subtitle in sentence form", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    // sampleDay services: 10 + 5 = 15 calls
    await waitFor(() => {
      expect(
        screen.getByText(/services received 15 calls/),
      ).toBeInTheDocument();
    });
    // Connector label "Slack" still appears in the row list
    expect(screen.getAllByText("Slack").length).toBeGreaterThanOrEqual(1);
  });

  it("should display connector label from CONNECTOR_TYPES for services", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      // "github" domain should render as "GitHub" via CONNECTOR_TYPES label
      expect(screen.getAllByText("GitHub").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("should display protected permissions card when denied > 0", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Protected")).toBeInTheDocument();
    });
  });

  it("should show ConnectorName(description) for permissions with description", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      // "chat:write" with connectorType "slack" → "Slack(chat:write)"
      // Appears in both allowed and blocked cards
      expect(
        screen.getAllByText("Slack(chat:write)").length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("should show plain connector label when permission label equals connectorType", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      // label "github" === connectorType "github" → just "GitHub"
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    // The permission "github" / connectorType "github" should render as "GitHub"
    expect(screen.getAllByText("GitHub").length).toBeGreaterThanOrEqual(1);
  });

  it("should not display protected card when no denials", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        permissions: [
          {
            label: "chat:write",
            allowed: 10,
            denied: 0,
            agentNames: ["Alpha Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Protected")).not.toBeInTheDocument();
  });

  it("should show Yesterday header for yesterday's data", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Yesterday")).toBeInTheDocument();
    });
  });

  it("should render every day's masonry with a date title above it", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago),
      sampleDay(day2Ago, {
        agents: [
          { agentName: "Gamma Bot", agentId: "a-3", runs: 1, credits: 10 },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Yesterday")).toBeInTheDocument();
    });
    // Both days render their full masonry — agent names from each day visible
    expect(screen.getByText("Alpha Bot")).toBeInTheDocument();
    expect(screen.getByText("Gamma Bot")).toBeInTheDocument();
    // PermissionsAllowedCard heading appears once per day's masonry
    expect(screen.getAllByText("Allowed")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Date range filter
// ---------------------------------------------------------------------------

describe("network insights page - date range filter", () => {
  it("should show date range dropdown when data exists", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
  });

  it("should not show date range dropdown when no data", async () => {
    mockInsightsAPI([]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByText("Run an agent to see insights here."),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Last 7 Days")).not.toBeInTheDocument();
  });

  it("should show no-activity message when filter excludes all days", async () => {
    // Only data from 20 days ago, but default range is "last7"
    mockInsightsAPI([sampleDay(day20Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByText("No activity in this time range."),
      ).toBeInTheDocument();
    });
  });

  it("should switch to Last 30 Days range and surface older day's masonry", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago),
      sampleDay(day25Ago, {
        agents: [
          { agentName: "OldBot", agentId: "a-old", runs: 1, credits: 5 },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    // Default is "Last 7 Days" — OldBot's day filtered out entirely
    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
    expect(screen.queryByText("OldBot")).not.toBeInTheDocument();

    click(screen.getByText("Last 7 Days"));
    await waitFor(() => {
      expect(screen.getByText("Last 30 Days")).toBeInTheDocument();
    });
    click(screen.getByText("Last 30 Days"));

    // Older day's masonry is now rendered in full — OldBot visible
    await waitFor(() => {
      expect(screen.getByText("OldBot")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

describe("network insights page - summary card", () => {
  it("should show blocked summary when denials exist", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        permissions: [
          {
            label: "chat:write",
            allowed: 8,
            denied: 5,
            agentNames: ["Alpha Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/5 requests were blocked/)).toBeInTheDocument();
    });
  });

  it("should show busy day summary for high run count", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        agents: [
          { agentName: "A1", agentId: "a-1", runs: 5, credits: 50 },
          { agentName: "A2", agentId: "a-2", runs: 5, credits: 50 },
        ],
        permissions: [],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/busy day/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Data refetch on navigation
// ---------------------------------------------------------------------------

describe("network insights page - data refetch", () => {
  it("should fetch fresh data when navigating to insights page", async () => {
    let callCount = 0;
    server.use(
      mockApi(zeroInsightsContract.get, ({ respond }) => {
        callCount++;
        const agents =
          callCount <= 1
            ? [
                {
                  agentName: "InitialBot",
                  agentId: "a-init",
                  runs: 1,
                  credits: 10,
                },
              ]
            : [
                {
                  agentName: "RefreshedBot",
                  agentId: "a-ref",
                  runs: 2,
                  credits: 20,
                },
              ];
        return respond(200, {
          days: [sampleDay(day1Ago, { agents })],
          totalCredits: 10,
          totalRuns: 1,
          lastUpdated: new Date().toISOString(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    // The page setup calls reloadInsights$ which triggers a second fetch,
    // so the UI should eventually show the refreshed data in the masonry.
    await waitFor(() => {
      expect(screen.getByText("RefreshedBot")).toBeInTheDocument();
    });
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Team credit usage card (admin-only)
// ---------------------------------------------------------------------------

describe("network insights page - team credit usage card", () => {
  it("should display Team Credit Usage heading for admin users", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    // Default MSW handler returns role: "admin"
    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Team Credit Usage")).toBeInTheDocument();
    });
  });

  it("should display team member names in team card", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("should display credit balance", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("9.8 K")).toBeInTheDocument();
    });
  });

  it("should not display Team Credit Usage card for non-admin users", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    // Override org API to return member role
    setMockOrg({ role: "member" });

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Your Credit Usage")).toBeInTheDocument();
    });
    expect(screen.queryByText("Team Credit Usage")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Your credit usage card (everyone)
// ---------------------------------------------------------------------------

describe("network insights page - your credit usage card", () => {
  it("should display Your Credit Usage heading", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Your Credit Usage")).toBeInTheDocument();
    });
  });

  it("should show personal credits matching the current user", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        teamUsage: [
          {
            name: "me",
            credits: 75,
            agentNames: ["Alpha Bot"],
            agentCredits: { "Alpha Bot": 75 },
          },
          {
            name: "other",
            credits: 125,
            agentNames: ["Beta Bot"],
            agentCredits: { "Beta Bot": 125 },
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    // "Your Credit Usage" card should show the current user's credits (75)
    await waitFor(() => {
      expect(screen.getByText("Your Credit Usage")).toBeInTheDocument();
    });
    expect(screen.getByText("75")).toBeInTheDocument();
  });

  it("should show 0 credits when current user has no usage", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        teamUsage: [
          {
            name: "someone",
            credits: 200,
            agentNames: ["Alpha Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Your Credit Usage")).toBeInTheDocument();
    });
    // No match for current user → 0 (scoped to the Your Credit Usage card)
    const yourUsageHeading = screen.getByText("Your Credit Usage");
    const yourUsageCard = yourUsageHeading.closest("div") as HTMLElement;
    expect(within(yourUsageCard).getByText("0")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Allowed permissions card — load more toggle
// ---------------------------------------------------------------------------

describe("network insights page - allowed permissions load more", () => {
  it("should show Load more button when more than 5 permissions", async () => {
    const manyPermissions = Array.from({ length: 8 }, (_, i) => {
      return {
        label: `perm-${i}`,
        connectorType: `svc-${i}`,
        allowed: i + 1,
        denied: 0,
        agentNames: ["Alpha Bot"],
      };
    });
    mockInsightsAPI([sampleDay(day1Ago, { permissions: manyPermissions })]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeInTheDocument();
    });
  });

  it("should not show Load more button when 5 or fewer permissions", async () => {
    const fewPermissions = Array.from({ length: 4 }, (_, i) => {
      return {
        label: `perm-${i}`,
        connectorType: `svc-${i}`,
        allowed: i + 1,
        denied: 0,
        agentNames: ["Alpha Bot"],
      };
    });
    mockInsightsAPI([sampleDay(day1Ago, { permissions: fewPermissions })]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  });

  it("should expand all permissions on Load more click", async () => {
    const manyPermissions = Array.from({ length: 7 }, (_, i) => {
      return {
        label: `action-${i}`,
        connectorType: `connector-${i}`,
        allowed: 1,
        denied: 0,
        agentNames: ["Alpha Bot"],
      };
    });
    mockInsightsAPI([sampleDay(day1Ago, { permissions: manyPermissions })]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Load more")).toBeInTheDocument();
    });

    // Only first 5 visible initially; permission 6 (action-6) should not be visible
    expect(screen.queryByText("action-6")).not.toBeInTheDocument();

    click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText("action-6")).toBeInTheDocument();
    });
    // Button should now say "Show less"
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Allowed permissions card — redesigned layout
// ---------------------------------------------------------------------------

describe("network insights page - allowed card layout", () => {
  it("should show connector name and description on separate lines", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        services: [],
        permissions: [
          {
            label: "chat:write",
            connectorType: "slack",
            allowed: 8,
            denied: 0,
            agentNames: ["Alpha Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    // Description (label) displayed separately below the connector name
    expect(screen.getByText("chat:write")).toBeInTheDocument();
    // Call count with "calls" label
    expect(screen.getByText("8 calls")).toBeInTheDocument();
  });

  it("should show calls count with singular form", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        permissions: [
          {
            label: "repo:read",
            connectorType: "github",
            allowed: 1,
            denied: 0,
            agentNames: ["Beta Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("1 call")).toBeInTheDocument();
    });
  });

  it("should not show description when label equals connectorType", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        services: [],
        permissions: [
          {
            label: "github",
            connectorType: "github",
            allowed: 5,
            denied: 0,
            agentNames: ["Beta Bot"],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    expect(screen.getByText("5 calls")).toBeInTheDocument();
    // "calls made within 1 granted permission" — updated text
    expect(
      screen.getByText(/calls made within 1 granted permission/),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Embedded usage panels (chart + schedules + chats)
// ---------------------------------------------------------------------------

describe("network insights page - embedded usage panels", () => {
  it("renders the Usage chart and tables when the Time range tab is active", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    // Default tab is daily breakdown — switch to Time range to expose Usage view
    await waitFor(() => {
      expect(screen.getByText("Time range")).toBeInTheDocument();
    });
    click(screen.getByText("Time range"));

    await waitFor(() => {
      expect(
        within(
          screen.getByRole("region", { name: "Credits totals" }),
        ).getByText("credits"),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });
    expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
  });

  it("does not render the Usage panels when there is no insights data", async () => {
    mockInsightsAPI([]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(
        screen.getByText("Run an agent to see insights here."),
      ).toBeInTheDocument();
    });
    // Tabs are not shown in the empty state, so Time range cannot be reached
    expect(screen.queryByText("Time range")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Credits totals" }),
    ).not.toBeInTheDocument();
  });

  it("renders the Time range tab even when the daily filter excludes all days", async () => {
    mockInsightsAPI([sampleDay(day20Ago)]);
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Daily breakdown")).toBeInTheDocument();
    });
    click(screen.getByText("Daily breakdown"));
    await waitFor(() => {
      expect(
        screen.getByText("No activity in this time range."),
      ).toBeInTheDocument();
    });
    click(screen.getByText("Time range"));

    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Credits totals" }),
      ).toBeInTheDocument();
    });
  });

  it("requests 30d usage when Last 30 Days is selected", async () => {
    let capturedRange: string | null = null;
    mockInsightsAPI([
      sampleDay(day1Ago),
      sampleDay(day25Ago, {
        agents: [
          { agentName: "OldBot", agentId: "a-old", runs: 1, credits: 5 },
        ],
      }),
    ]);
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        capturedRange = query.range;
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
    click(screen.getByText("Last 7 Days"));
    await waitFor(() => {
      expect(screen.getByText("Last 30 Days")).toBeInTheDocument();
    });
    click(screen.getByText("Last 30 Days"));
    click(screen.getByText("Time range"));

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });
    expect(capturedRange).toBe("30d");
  });

  it("requests a single-day usage window for a selected day", async () => {
    let capturedQuery: { range: string; date?: string } | null = null;
    mockInsightsAPI([sampleDay(day1Ago)]);
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        capturedQuery = { range: query.range, date: query.date };
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
    click(screen.getByText("Last 7 Days"));
    const findYesterdayItem = () => {
      return screen.getAllByRole("menuitem").find((item) => {
        return item.textContent === "Yesterday";
      });
    };
    await waitFor(() => {
      expect(findYesterdayItem()).toBeDefined();
    });
    click(findYesterdayItem()!);
    click(screen.getByText("Time range"));

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });
    expect(capturedQuery).toStrictEqual({ range: "day", date: day1Ago });
  });
});

// ---------------------------------------------------------------------------
// Tabs — daily breakdown vs. time-range
// ---------------------------------------------------------------------------

describe("network insights page - tabs", () => {
  it("defaults to the daily breakdown tab", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Daily breakdown")).toBeInTheDocument();
    });
    // Newest day's masonry is visible under daily tab
    expect(screen.getByText("Allowed")).toBeInTheDocument();
  });

  it("switches to time range and hides the per-day diary", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Time range")).toBeInTheDocument();
    });
    click(screen.getByText("Time range"));

    // Daily masonry artifact gone; time-range view's totals region appears.
    await waitFor(() => {
      expect(
        screen.getByRole("region", { name: "Credits totals" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Allowed")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Per-day Schedules / Chats cards
// ---------------------------------------------------------------------------

describe("network insights page - per-day schedules and chats", () => {
  it("renders Schedules card inside the day masonry", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        schedules: [
          {
            scheduleId: "sch-1",
            scheduleName: "morning-brief",
            scheduleDescription: "Morning summary",
            credits: 80,
            tokens: 8000,
          },
          {
            scheduleId: "sch-2",
            scheduleName: "weekly-report",
            scheduleDescription: null,
            credits: 40,
            tokens: 4000,
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    // Card heading + the two schedule names visible inside the expanded day
    await waitFor(() => {
      expect(screen.getByText("Schedules")).toBeInTheDocument();
    });
    expect(screen.getByText("Morning summary")).toBeInTheDocument();
    expect(screen.getByText("weekly-report")).toBeInTheDocument();
  });

  it("renders Chats card inside the day masonry", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        chats: [
          {
            threadId: "t-1",
            threadTitle: "Refactor billing",
            credits: 60,
            tokens: 6000,
          },
          {
            threadId: "t-2",
            threadTitle: null,
            credits: 30,
            tokens: 3000,
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Chats")).toBeInTheDocument();
    });
    expect(screen.getByText("Refactor billing")).toBeInTheDocument();
    expect(screen.getByText("(untitled)")).toBeInTheDocument();
  });

  it("hides the Schedules card when no schedules fired that day", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Schedules")).not.toBeInTheDocument();
    expect(screen.queryByText("Chats")).not.toBeInTheDocument();
  });

  it("folds extra schedules behind a +N more toggle and reveals them on click", async () => {
    const many = Array.from({ length: 7 }, (_, i) => {
      return {
        scheduleId: `sch-${i}`,
        scheduleName: `schedule-${i}`,
        scheduleDescription: null,
        credits: 10 * (i + 1),
        tokens: 1000 * (i + 1),
      };
    });
    mockInsightsAPI([sampleDay(day1Ago, { schedules: many })]);

    detachedSetupPage({ context, path: "/insights" });

    // First 4 visible, schedule-6 hidden behind the toggle
    await waitFor(() => {
      expect(screen.getByText("+3 more schedules")).toBeInTheDocument();
    });
    expect(screen.queryByText("schedule-6")).not.toBeInTheDocument();

    click(screen.getByText("+3 more schedules"));

    await waitFor(() => {
      expect(screen.getByText("schedule-6")).toBeInTheDocument();
    });
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("renders schedule rows as links to the schedule detail page", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        schedules: [
          {
            scheduleId: "sch-link",
            scheduleName: "linked-schedule",
            scheduleDescription: null,
            credits: 50,
            tokens: 5000,
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("linked-schedule")).toBeInTheDocument();
    });
    const link = screen.getByText("linked-schedule").closest("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/schedules/sch-link");
  });

  it("renders chat rows as links to the chat thread", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        chats: [
          {
            threadId: "thread-link",
            threadTitle: "Linked thread",
            credits: 50,
            tokens: 5000,
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Linked thread")).toBeInTheDocument();
    });
    const link = screen.getByText("Linked thread").closest("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("/chats/thread-link");
  });

  it("matches AgentsCard subtitle style: '{noun} used {N} credits' with inline credit unit per row", async () => {
    mockInsightsAPI([
      sampleDay(day1Ago, {
        schedules: [
          {
            scheduleId: "s1",
            scheduleName: "a",
            scheduleDescription: null,
            credits: 60,
            tokens: 6000,
          },
          {
            scheduleId: "s2",
            scheduleName: "b",
            scheduleDescription: null,
            credits: 40,
            tokens: 4000,
          },
        ],
        chats: [
          {
            threadId: "t1",
            threadTitle: "x",
            credits: 30,
            tokens: 3000,
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    // Schedules: subtitle in sentence form, total = 60 + 40 = 100
    await waitFor(() => {
      expect(
        screen.getByText(/schedules used 100 credits/),
      ).toBeInTheDocument();
    });
    // Chats: singular "chat used" with the total
    expect(screen.getByText(/chat used 30 credits/)).toBeInTheDocument();
    // Per-row values are bare numbers — subtitle already names the unit
    expect(screen.queryByText(/^60 credits?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^40 credits?$/)).not.toBeInTheDocument();
  });
});
