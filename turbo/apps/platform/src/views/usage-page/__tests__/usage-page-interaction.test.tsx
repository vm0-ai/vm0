/**
 * Interaction tests for usage-page components.
 * Tests that selector changes (range, groupBy) trigger API re-fetch with
 * updated query parameters.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroUsageInsightContract } from "@vm0/core";
import { usageInsightFixture } from "./test-fixtures.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

function getTotalsRegion(): HTMLElement {
  return screen.getByRole("region", { name: "Credits totals" });
}

function emptyUsageInsight() {
  return {
    buckets: [],
    schedules: [],
    scheduleOtherCount: 0,
    scheduleOtherCredits: 0,
    chats: [],
    chatOtherCount: 0,
    chatOtherCredits: 0,
    emailCredits: 0,
    emailTokens: 0,
    slackCredits: 0,
    slackTokens: 0,
    grandTotalCredits: 0,
    grandTotalTokens: 0,
  };
}

describe("/_/usage page - selector interactions", () => {
  it("re-fetches with range=7d when Last 7 days is selected", async () => {
    let capturedRange: string | undefined;

    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        capturedRange = query.range;
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Wait for initial fetch to complete
    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    // Reset captured value and click the range selector
    capturedRange = undefined;
    const rangeSelect = await screen.findByRole("combobox", {
      name: "Date range",
    });
    click(rangeSelect);

    const option = await screen.findByRole("option", { name: "Last 7 days" });
    click(option);

    await waitFor(() => {
      expect(capturedRange).toBe("7d");
    });
  });

  it("re-fetches with groupBy=agent when By Agent is selected", async () => {
    let capturedGroupBy: string | undefined;

    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        capturedGroupBy = query.groupBy;
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Wait for initial fetch to complete
    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    // Reset captured value and click the "Agent" tab in the group-by toggle
    capturedGroupBy = undefined;
    const agentTab = await screen.findByText("Agent");
    click(agentTab);

    await waitFor(() => {
      expect(capturedGroupBy).toBe("agent");
    });
  });
});

describe("/_/usage page - bucket densification", () => {
  it("fills yesterday as the full local calendar day", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-04-27T05:30:00.000Z").getTime(),
    );

    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        if (query.range !== "yesterday") {
          return respond(200, emptyUsageInsight());
        }
        return respond(200, {
          ...emptyUsageInsight(),
          buckets: [
            {
              ts: "2026-04-26T23:00:00.000Z",
              series: { chat: 11 },
              tokens: { chat: 22 },
            },
          ],
          grandTotalCredits: 11,
          grandTotalTokens: 22,
        });
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    const rangeSelect = await screen.findByRole("combobox", {
      name: "Date range",
    });
    click(rangeSelect);
    click(await screen.findByRole("option", { name: "Yesterday" }));

    await waitFor(() => {
      expect(within(getTotalsRegion()).getByText("23")).toBeInTheDocument();
    });
  });

  it("uses the preference timezone when filling daily buckets", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-04-27T05:30:00.000Z").getTime(),
    );
    setMockUserPreferences({ timezone: "America/Los_Angeles" });
    let capturedTz: string | undefined;

    server.use(
      mockApi(zeroUsageInsightContract.get, ({ query, respond }) => {
        capturedTz = query.tz;
        if (query.range !== "7d") {
          return respond(200, emptyUsageInsight());
        }
        return respond(200, {
          ...emptyUsageInsight(),
          buckets: [
            {
              ts: "2026-04-20T00:00:00.000Z",
              series: { chat: 42 },
              tokens: { chat: 84 },
            },
          ],
          grandTotalCredits: 42,
          grandTotalTokens: 84,
        });
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    const rangeSelect = await screen.findByRole("combobox", {
      name: "Date range",
    });
    click(rangeSelect);
    click(await screen.findByRole("option", { name: "Last 7 days" }));

    await waitFor(() => {
      expect(capturedTz).toBe("America/Los_Angeles");
      expect(within(getTotalsRegion()).getByText("Apr 20")).toBeInTheDocument();
    });
    expect(
      within(getTotalsRegion()).queryByText("Apr 27"),
    ).not.toBeInTheDocument();
  });
});

describe("/_/usage page - error state", () => {
  it("shows error message when API fails", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(500, {
          error: { message: "Internal server error", code: "INTERNAL" },
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
});

describe("/_/usage page - empty state", () => {
  it("shows zero credits when no data", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, {
          buckets: [],
          schedules: [],
          scheduleOtherCount: 0,
          scheduleOtherCredits: 0,
          chats: [],
          chatOtherCount: 0,
          chatOtherCredits: 0,
          emailCredits: 0,
          emailTokens: 0,
          slackCredits: 0,
          slackTokens: 0,
          grandTotalCredits: 0,
          grandTotalTokens: 0,
        });
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Totals card should still show 0 credits with zero grand total
    await waitFor(() => {
      expect(
        within(getTotalsRegion()).getByText("credits"),
      ).toBeInTheDocument();
    });

    expect(within(getTotalsRegion()).getByText("0")).toBeInTheDocument();
    expect(within(getTotalsRegion()).getByText("credits")).toBeInTheDocument();
  });
});

describe("/_/usage page - schedule and chat lists", () => {
  it("shows schedules and chats side-by-side", async () => {
    server.use(
      mockApi(zeroUsageInsightContract.get, ({ respond }) => {
        return respond(200, usageInsightFixture);
      }),
    );

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });

    expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
  });
});
