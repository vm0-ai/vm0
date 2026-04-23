/**
 * Interaction tests for usage-page components.
 * Tests that selector changes (range, groupBy) trigger API re-fetch with
 * updated query parameters.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroUsageInsightContract } from "@vm0/core";
import { usageInsightFixture } from "./test-fixtures.ts";

const context = testContext();

beforeEach(() => {
  resetAllMockHandlers();
});

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
        screen.getByRole("img", { name: /Total credits breakdown/ }),
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
        screen.getByRole("img", { name: /Total credits breakdown/ }),
      ).toBeInTheDocument();
    });

    // Reset captured value and click the groupBy selector
    capturedGroupBy = undefined;
    const groupBySelect = await screen.findByRole("combobox", {
      name: "Group by",
    });
    click(groupBySelect);

    const option = await screen.findByRole("option", { name: "By Agent" });
    click(option);

    await waitFor(() => {
      expect(capturedGroupBy).toBe("agent");
    });
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

    // Totals bar should show 0 credits with zero grand total
    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: /Total credits breakdown/ }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("credits")).toBeInTheDocument();
  });
});

describe("/_/usage page - detail tabs", () => {
  it("switches from schedules to chats tab", async () => {
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

    // Schedules tab should be visible by default
    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
    });

    // Click on Chats tab
    const chatsTab = await screen.findByText("Chats");
    click(chatsTab);

    await waitFor(() => {
      expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
    });

    // Schedules should no longer be visible
    expect(screen.queryByText("My Schedule")).not.toBeInTheDocument();
  });
});
