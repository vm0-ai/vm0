/**
 * Interaction tests for the Network Insights page.
 *
 * Covers rendering insight cards, date range filtering, empty states,
 * and agent hover interactions.
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

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

function mockInsightsAPI(days: Record<string, unknown>[] = []) {
  server.use(
    http.get("*/api/zero/insights", () => {
      const totalCredits = days.reduce((s, d) => {
        return s + ((d.creditsUsed as number) ?? 0);
      }, 0);
      const totalRuns = days.reduce((s, d) => {
        const agents = (d.agents as { runs: number }[]) ?? [];
        return (
          s +
          agents.reduce((rs, a) => {
            return rs + (a.runs ?? 0);
          }, 0)
        );
      }, 0);
      const lastUpdated = days.length > 0 ? new Date().toISOString() : null;
      return HttpResponse.json({ days, totalCredits, totalRuns, lastUpdated });
    }),
  );
}

function sampleDay(date: string, overrides?: Record<string, unknown>) {
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
        userId: "user-alice",
        name: "alice",
        credits: 120,
        agentNames: ["Alpha Bot"],
        agentCredits: { "Alpha Bot": 120 },
      },
      {
        userId: "user-bob",
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
  it("should render the Insights heading", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Insights")).toBeInTheDocument();
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

  it("should display most-used service with proper connector label", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    detachedSetupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/Most used:/)).toBeInTheDocument();
    });
    // "slack" domain should render as "Slack" via CONNECTOR_TYPES label
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

  it("should render multiple days", async () => {
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
      expect(screen.getByText("Alpha Bot")).toBeInTheDocument();
    });
    expect(screen.getByText("Gamma Bot")).toBeInTheDocument();
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

  it("should switch to Last 30 Days range", async () => {
    const user = userEvent.setup();
    mockInsightsAPI([
      sampleDay(day1Ago),
      sampleDay(day25Ago, {
        agents: [
          { agentName: "OldBot", agentId: "a-old", runs: 1, credits: 5 },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/insights" });

    // Default is "Last 7 Days" — OldBot not visible
    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
    expect(screen.queryByText("OldBot")).not.toBeInTheDocument();

    // Open dropdown and select "Last 30 Days"
    await user.click(screen.getByText("Last 7 Days"));
    await waitFor(() => {
      expect(screen.getByText("Last 30 Days")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Last 30 Days"));

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
      http.get("*/api/zero/insights", () => {
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
        return HttpResponse.json({
          days: [sampleDay(day1Ago, { agents })],
          totalCredits: 10,
          totalRuns: 1,
          lastUpdated: new Date().toISOString(),
        });
      }),
    );

    detachedSetupPage({ context, path: "/insights" });

    // The page setup calls reloadInsights$ which triggers a second fetch,
    // so the UI should eventually show the refreshed data.
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
      expect(screen.getByText("9,800")).toBeInTheDocument();
    });
  });

  it("should not display Team Credit Usage card for non-admin users", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    // Override org API to return member role
    server.use(
      http.get("*/api/zero/org", () => {
        return HttpResponse.json({
          id: "org_1",
          slug: "user-12345678",
          name: "User 12345678",
          role: "member",
        });
      }),
    );

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
            userId: "test-user-123",
            name: "me",
            credits: 75,
            agentNames: ["Alpha Bot"],
            agentCredits: { "Alpha Bot": 75 },
          },
          {
            userId: "other-user",
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
            userId: "someone-else",
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
    // No match for current user → 0
    expect(screen.getByText("0")).toBeInTheDocument();
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
    const user = userEvent.setup();
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

    await user.click(screen.getByText("Load more"));

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
