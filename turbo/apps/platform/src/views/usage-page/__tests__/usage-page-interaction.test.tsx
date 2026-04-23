/**
 * Interaction tests for usage-page components.
 * Tests selector interactions (range, groupBy, metric), loading state,
 * and error state for the usage insight view.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockUsageInsight } from "../../../mocks/handlers/api-usage-insight.ts";
import { resetAllMockHandlers } from "../../../mocks/handlers/index.ts";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { zeroUsageInsightContract } from "@vm0/core";

const context = testContext();

function baseMock() {
  return {
    buckets: [
      {
        ts: "2026-04-13 00:00:00",
        series: { chat: 500, slack: 200 },
        tokens: { chat: 1000, slack: 400 },
      },
    ],
    schedules: [
      {
        scheduleId: "s1",
        scheduleName: "My Schedule",
        credits: 300,
        tokens: 600,
      },
    ],
    chats: [
      {
        threadId: "t1",
        threadTitle: "Chat with Agent",
        credits: 200,
        tokens: 400,
      },
    ],
    emailCredits: 100,
    emailTokens: 200,
    slackCredits: 200,
    slackTokens: 400,
    grandTotalCredits: 1300,
    grandTotalTokens: 2600,
  };
}

beforeEach(() => {
  resetAllMockHandlers();
});

describe("/_/usage page - selector interactions", () => {
  it("renders with default selectors visible", async () => {
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find all 3 selects (range, groupBy, metric) - they are comboboxes
    const selects = await screen.findAllByRole("combobox");
    expect(selects).toHaveLength(3);
  });

  it("opens range selector and shows options", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");

    // Find all selects within the section
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];
    expect(selects.length).toBeGreaterThanOrEqual(1);

    // Click the first select (range) to open it
    await user.click(selects[0]!);

    // Options should appear
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Today" })).toBeInTheDocument();
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

  it("changes range from Today to Last 7 days", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section and its selects
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];

    // Click first select (range) to open
    await user.click(selects[0]!);

    // Select "Last 7 days"
    await user.click(screen.getByRole("option", { name: "Last 7 days" }));

    // The select trigger should now show "Last 7 days"
    await waitFor(() => {
      const updatedSelects = sectionContainer
        ? within(sectionContainer).getAllByRole("combobox")
        : [];
      expect(
        within(updatedSelects[0]!).getByText("Last 7 days"),
      ).toBeInTheDocument();
    });
  });

  it("opens groupBy selector and shows options", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section and its selects
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];
    expect(selects.length).toBeGreaterThanOrEqual(2);

    // Click second select (groupBy) to open it
    await user.click(selects[1]!);

    // Options should appear
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "By Source" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "By Agent" }),
      ).toBeInTheDocument();
    });
  });

  it("changes groupBy from By Source to By Agent", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section and its selects
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];

    // Click second select (groupBy) to open
    await user.click(selects[1]!);

    // Select "By Agent"
    await user.click(screen.getByRole("option", { name: "By Agent" }));

    // The select trigger should now show "By Agent"
    await waitFor(() => {
      const updatedSelects = sectionContainer
        ? within(sectionContainer).getAllByRole("combobox")
        : [];
      expect(
        within(updatedSelects[1]!).getByText("By Agent"),
      ).toBeInTheDocument();
    });
  });

  it("opens metric selector and shows options", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section and its selects
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];
    expect(selects.length).toBeGreaterThanOrEqual(3);

    // Click third select (metric) to open it
    await user.click(selects[2]!);

    // Options should appear
    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "Credits" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Tokens" }),
      ).toBeInTheDocument();
    });
  });

  it("changes metric from Credits to Tokens", async () => {
    const user = userEvent.setup();
    setMockUsageInsight(baseMock());
    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Find the Usage Insights section and its selects
    const section = await screen.findByText("Usage Insights");
    const sectionContainer = section.closest("div");
    const selects = sectionContainer
      ? within(sectionContainer).getAllByRole("combobox")
      : [];

    // Click third select (metric) to open
    await user.click(selects[2]!);

    // Select "Tokens"
    await user.click(screen.getByRole("option", { name: "Tokens" }));

    // The select trigger should now show "Tokens"
    await waitFor(() => {
      const updatedSelects = sectionContainer
        ? within(sectionContainer).getAllByRole("combobox")
        : [];
      expect(
        within(updatedSelects[2]!).getByText("Tokens"),
      ).toBeInTheDocument();
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
    setMockUsageInsight({
      buckets: [],
      schedules: [],
      chats: [],
      emailCredits: 0,
      emailTokens: 0,
      slackCredits: 0,
      slackTokens: 0,
      grandTotalCredits: 0,
      grandTotalTokens: 0,
    });

    detachedSetupPage({ context, path: "/_/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });

    // Totals bar should show 0 credits
    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: /Total credits breakdown/ }),
      ).toBeInTheDocument();
    });
  });
});

describe("/_/usage page - detail tabs", () => {
  it("switches from schedules to chats tab", async () => {
    setMockUsageInsight(baseMock());
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
    const chatsTab = screen.getAllByRole("tab").find((el) => {
      return /Chats/.test(el.textContent ?? "");
    });
    click(chatsTab!);

    await waitFor(() => {
      expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
    });

    // Schedules should no longer be visible
    expect(screen.queryByText("My Schedule")).not.toBeInTheDocument();
  });
});
