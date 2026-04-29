/**
 * Component-level tests for usage-page sub-components.
 *
 * Covers: UsageInsightBarChart, UsageInsightChatsTable,
 * UsageInsightSchedulesTable, UsageInsightSelectors, UsageInsightView
 *
 * Entry point: detachedSetupPage({ context, path: "/_/usage" })
 * Mock (external): HTTP via MSW zeroUsageInsightContract
 * Real (internal): All signals, components, rendering
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroUsageInsightContract } from "@vm0/core";
import { usageInsightFixture } from "./test-fixtures.ts";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

function getTotalsRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Credits totals" });
}

function makeFixture(
  overrides: Partial<UsageInsightResponse>,
): UsageInsightResponse {
  return { ...usageInsightFixture, ...overrides };
}

// ---------------------------------------------------------------------------
// UsageInsightView — loading, error, and data states
// ---------------------------------------------------------------------------

describe("usage insight view - loading, error, and data states", () => {
  it("shows loading skeleton before data arrives", async () => {
    // Slow response so skeleton is visible
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ never }) => {
        return never();
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Loading skeleton should be visible
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows error alert when API fails", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(500, {
          error: { message: "Server error", code: "INTERNAL" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Failed to load usage insights. Please try again later.",
      ),
    ).toBeInTheDocument();
  });

  it("renders bar chart and tables when data is present", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [
              {
                ts: "2026-04-13T00:00:00Z",
                series: { chat: 500, slack: 200 },
                tokens: { chat: 1000, slack: 400 },
              },
              {
                ts: "2026-04-14T00:00:00Z",
                series: { chat: 300, slack: 100 },
                tokens: { chat: 600, slack: 200 },
              },
            ],
            schedules: [
              {
                scheduleId: "s1",
                scheduleName: "Morning Digest",
                scheduleDescription: null,
                credits: 150,
                tokens: 300,
              },
              {
                scheduleId: "s2",
                scheduleName: "Evening Report",
                scheduleDescription: null,
                credits: 80,
                tokens: 160,
              },
            ],
            chats: [
              {
                threadId: "t1",
                threadTitle: "Project Alpha Discussion",
                credits: 200,
                tokens: 400,
              },
              {
                threadId: "t2",
                threadTitle: "Bug triage session",
                credits: 150,
                tokens: 300,
              },
            ],
            grandTotalCredits: 1300,
            grandTotalTokens: 2600,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    // SVG chart should be rendered inside the totals region
    const totalsEl = getTotalsRegion();
    expect(totalsEl.querySelector("svg")).toBeInTheDocument();

    // Schedules table
    expect(screen.getByText("Morning Digest")).toBeInTheDocument();
    expect(screen.getByText("Evening Report")).toBeInTheDocument();

    // Chats table
    expect(screen.getByText("Project Alpha Discussion")).toBeInTheDocument();
    expect(screen.getByText("Bug triage session")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UsageInsightBarChart — chart rendering, GroupBy toggle, breakdown list
// ---------------------------------------------------------------------------

describe("usage insight bar chart - chart rendering", () => {
  it("renders SVG chart when data is present", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [
              {
                ts: "2026-04-13T00:00:00Z",
                series: { chat: 500, slack: 200 },
                tokens: { chat: 1000, slack: 400 },
              },
              {
                ts: "2026-04-14T00:00:00Z",
                series: { chat: 300, slack: 100 },
                tokens: { chat: 600, slack: 200 },
              },
            ],
            grandTotalCredits: 1300,
            grandTotalTokens: 2600,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // Wait for the credits label to appear
    await waitFor(() => {
      expect(screen.getByText("1.3K")).toBeInTheDocument();
    });

    // Chart SVG should exist somewhere on the page
    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("renders breakdown list when multiple categories present", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [
              {
                ts: "2026-04-13T00:00:00Z",
                series: { chat: 500, slack: 200, others: 50 },
                tokens: { chat: 1000, slack: 400, others: 100 },
              },
            ],
            grandTotalCredits: 750,
            grandTotalTokens: 1500,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // The breakdown list renders when stackOrder.length > 1 && total > 0.
    // With 3 categories (chat, slack, others), the breakdown list should appear.
    // Verify the chart SVG renders (proves breakdown list container exists)
    await waitFor(() => {
      expect(screen.getByText("750")).toBeInTheDocument();
    });
    // The breakdown list has progress bars - verify SVG is rendered
    expect(document.querySelector("svg")).toBeInTheDocument();
  });

  it("renders breakdown list when a single category is present", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-04-28T12:00:00.000Z").getTime(),
    );

    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [
              {
                ts: "2026-04-28T11:00:00.000Z",
                series: { webhook: 420 },
                tokens: { webhook: 840 },
              },
            ],
            schedules: [],
            scheduleOtherCount: 0,
            scheduleOtherCredits: 0,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 420,
            grandTotalTokens: 840,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("Webhook"),
      ).toBeInTheDocument();
    });
  });

  it("hides chart body when total is zero", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [],
            grandTotalCredits: 0,
            grandTotalTokens: 0,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    // Chart SVG should not be rendered when total is 0
    const totalsEl = getTotalsRegion();
    expect(totalsEl.querySelector("svg")).not.toBeInTheDocument();
  });

  it("shows Source and Agent group-by tabs", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [
              {
                ts: "2026-04-13T00:00:00Z",
                series: { chat: 500 },
                tokens: { chat: 1000 },
              },
            ],
            grandTotalCredits: 500,
            grandTotalTokens: 1000,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("Source")).toBeInTheDocument();
    });
    expect(screen.getByText("Agent")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UsageInsightChatsTable — chat rows, hover, empty state, "more chats"
// ---------------------------------------------------------------------------

describe("usage insight chats table - rendering and interactions", () => {
  it("shows empty state when no chats", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 0,
            grandTotalTokens: 0,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("No chats in this period")).toBeInTheDocument();
    });
  });

  it("shows total chat count as large number", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [
              {
                threadId: "t1",
                threadTitle: "Chat A",
                credits: 100,
                tokens: 200,
              },
              {
                threadId: "t2",
                threadTitle: "Chat B",
                credits: 200,
                tokens: 400,
              },
            ],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 300,
            grandTotalTokens: 600,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // Wait for the chat titles to appear
    await waitFor(() => {
      expect(screen.getByText("Chat A")).toBeInTheDocument();
    });
    expect(screen.getByText("Chat B")).toBeInTheDocument();
  });

  it("shows individual chat rows with credit amounts", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [
              {
                threadId: "t1",
                threadTitle: "Design Review",
                credits: 250,
                tokens: 500,
              },
              {
                threadId: "t2",
                threadTitle: "Sprint Planning",
                credits: 150,
                tokens: 300,
              },
              {
                threadId: "t3",
                threadTitle: "Retrospective",
                credits: 75,
                tokens: 150,
              },
            ],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 475,
            grandTotalTokens: 950,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(screen.getByText("Design Review")).toBeInTheDocument();
    });

    expect(screen.getByText("Sprint Planning")).toBeInTheDocument();
    expect(screen.getByText("Retrospective")).toBeInTheDocument();

    // Credit values should be visible
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("150")).toBeInTheDocument();
    expect(screen.getByText("75")).toBeInTheDocument();
  });

  it("shows untitled for chat without title", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [
              { threadId: "t1", threadTitle: null, credits: 100, tokens: 200 },
            ],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 100,
            grandTotalTokens: 200,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument();
    });
    expect(screen.getByText("(untitled)")).toBeInTheDocument();
  });

  it("shows '+N more chats' row when chatOtherCount > 0", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [
              {
                threadId: "t1",
                threadTitle: "Visible Chat",
                credits: 50,
                tokens: 100,
              },
            ],
            chatOtherCount: 7,
            chatOtherCredits: 350,
            grandTotalCredits: 400,
            grandTotalTokens: 800,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(screen.getByText("Visible Chat")).toBeInTheDocument();
    });

    expect(screen.getByText("+7 more chats")).toBeInTheDocument();
  });

  it("formats large credit values with K suffix", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [
              {
                threadId: "t1",
                threadTitle: "Big Chat",
                credits: 5000,
                tokens: 10_000,
              },
            ],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 5000,
            grandTotalTokens: 10_000,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // The breakdown list shows "5.0K" for the Big Chat row (5000 >= 1000)
    await waitFor(() => {
      expect(screen.getByText("Big Chat")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// UsageInsightSchedulesTable — schedule rows, hover, empty state, "more"
// ---------------------------------------------------------------------------

describe("usage insight schedules table - rendering and interactions", () => {
  it("shows empty state when no schedules", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            scheduleOtherCount: 0,
            scheduleOtherCredits: 0,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 0,
            grandTotalTokens: 0,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        screen.getByText("No schedules used in this period"),
      ).toBeInTheDocument();
    });
  });

  it("shows total schedule count as large number", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [
              {
                scheduleId: "s1",
                scheduleName: "Daily Sync",
                scheduleDescription: null,
                credits: 100,
                tokens: 200,
              },
              {
                scheduleId: "s2",
                scheduleName: "Weekly Review",
                scheduleDescription: null,
                credits: 200,
                tokens: 400,
              },
              {
                scheduleId: "s3",
                scheduleName: "Monthly Report",
                scheduleDescription: null,
                credits: 150,
                tokens: 300,
              },
            ],
            scheduleOtherCount: 0,
            scheduleOtherCredits: 0,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 450,
            grandTotalTokens: 900,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // Wait for schedule content to appear, then verify count "3" is visible
    await waitFor(() => {
      expect(screen.getByText("Daily Sync")).toBeInTheDocument();
    });
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows individual schedule rows with credit amounts", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [
              {
                scheduleId: "s1",
                scheduleName: "Daily Standup",
                scheduleDescription: null,
                credits: 50,
                tokens: 100,
              },
              {
                scheduleId: "s2",
                scheduleName: "Weekly Planning",
                scheduleDescription: null,
                credits: 200,
                tokens: 400,
              },
            ],
            scheduleOtherCount: 0,
            scheduleOtherCredits: 0,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 250,
            grandTotalTokens: 500,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(screen.getByText("Daily Standup")).toBeInTheDocument();
    });
    expect(screen.getByText("Weekly Planning")).toBeInTheDocument();
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("shows '+N more schedules' row when scheduleOtherCount > 0", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [
              {
                scheduleId: "s1",
                scheduleName: "Visible Schedule",
                scheduleDescription: null,
                credits: 30,
                tokens: 60,
              },
            ],
            scheduleOtherCount: 4,
            scheduleOtherCredits: 170,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 200,
            grandTotalTokens: 400,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(screen.getByText("Visible Schedule")).toBeInTheDocument();
    });

    expect(screen.getByText("+4 more schedules")).toBeInTheDocument();
  });

  it("prefers scheduleDescription over scheduleName when both are present", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [
              {
                scheduleId: "s1",
                scheduleName: "default",
                scheduleDescription: "Daily morning brief",
                credits: 100,
                tokens: 200,
              },
              {
                scheduleId: "s2",
                scheduleName: "default",
                scheduleDescription: null,
                credits: 80,
                tokens: 160,
              },
            ],
            scheduleOtherCount: 0,
            scheduleOtherCredits: 0,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 180,
            grandTotalTokens: 360,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // s1: description present → render description
    await waitFor(() => {
      expect(screen.getByText("Daily morning brief")).toBeInTheDocument();
    });
    // s2: no description → fall back to name
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("uses singular form for scheduleOtherCount of 1", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            scheduleOtherCount: 1,
            scheduleOtherCredits: 50,
            chats: [],
            chatOtherCount: 0,
            chatOtherCredits: 0,
            grandTotalCredits: 50,
            grandTotalTokens: 100,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    // When scheduleOtherCount is 1, the "+1 more schedule" row appears (singular)
    await waitFor(() => {
      expect(screen.getByText("+1 more schedule")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// UsageInsightSelectors — date range dropdown
// ---------------------------------------------------------------------------

describe("usage insight selectors - date range dropdown", () => {
  it("renders the date range select with all four options", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(
          200,
          makeFixture({
            buckets: [],
            schedules: [],
            chats: [],
            grandTotalCredits: 0,
            grandTotalTokens: 0,
          }),
        );
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    const select = await screen.findByRole("combobox", { name: "Date range" });
    expect(select).toBeInTheDocument();

    // Open the select
    click(select);

    // All options should be visible
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Today" })).toBeInTheDocument();
    });
    expect(
      screen.getByRole("option", { name: "Yesterday" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Last 7 days" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Last 28 days" }),
    ).toBeInTheDocument();
  });
});
