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
import { setupPage } from "../../../__tests__/page-helper.ts";

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
      return HttpResponse.json({ days, totalCredits, totalRuns });
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
        name: "Slack",
        domain: "slack",
        calls: 10,
        agentNames: ["Alpha Bot"],
      },
      {
        name: "GitHub",
        domain: "github",
        calls: 5,
        agentNames: ["Beta Bot"],
      },
    ],
    permissions: [
      {
        label: "chat:write",
        allowed: 8,
        denied: 2,
        agentNames: ["Alpha Bot"],
      },
      {
        label: "contents:read",
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

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Insights")).toBeInTheDocument();
    });
  });

  it("should display agent names from the data", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Alpha Bot")).toBeInTheDocument();
    });
    expect(screen.getByText("Beta Bot")).toBeInTheDocument();
  });

  it("should display credit amount", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("200")).toBeInTheDocument();
    });
  });

  it("should display most-used service name", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/Most used:/)).toBeInTheDocument();
    });
    expect(screen.getAllByText("Slack").length).toBeGreaterThanOrEqual(1);
  });

  it("should display blocked permissions card when denied > 0", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Blocked")).toBeInTheDocument();
    });
  });

  it("should not display blocked card when no denials", async () => {
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

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Allowed")).toBeInTheDocument();
    });
    expect(screen.queryByText("Blocked")).not.toBeInTheDocument();
  });

  it("should show Yesterday header for yesterday's data", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("Last 7 Days")).toBeInTheDocument();
    });
  });

  it("should not show date range dropdown when no data", async () => {
    mockInsightsAPI([]);

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

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

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText(/busy day/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Team usage in credits card
// ---------------------------------------------------------------------------

describe("network insights page - credits card", () => {
  it("should display team member names", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("alice")).toBeInTheDocument();
    });
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("should display credit balance", async () => {
    mockInsightsAPI([sampleDay(day1Ago)]);

    await setupPage({ context, path: "/insights" });

    await waitFor(() => {
      expect(screen.getByText("9,800")).toBeInTheDocument();
    });
  });
});
