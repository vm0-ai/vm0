import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { zeroUsageInsightContract } from "@vm0/core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  usageInsightLast7DaysAgentFixture,
  usageInsightLast7DaysSourceFixture,
  usageInsightTodayFixture,
} from "./test-fixtures.ts";

const context = testContext();

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
}

describe("/usage page", () => {
  beforeEach(() => {
    mockNow();
  });

  it("shows a usage load error", async () => {
    context.mocks.api(zeroUsageInsightContract.get, ({ respond }) => {
      return respond(500, {
        error: {
          message: "Usage aggregation unavailable",
          code: "SERVICE_UNAVAILABLE",
        },
      });
    });

    detachedSetupPage({ context, path: "/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Failed to load usage insights. Please try again later.",
      );
    });
  });

  it("shows empty usage states", async () => {
    context.mocks.api(zeroUsageInsightContract.get, ({ respond }) => {
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
    });

    detachedSetupPage({ context, path: "/usage" });

    await waitFor(() => {
      expect(
        screen.getByText("No schedules used in this period"),
      ).toBeInTheDocument();
      expect(screen.getByText("No chats in this period")).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole("region", { name: "Credits totals" })).getByText(
        "0",
      ),
    ).toBeInTheDocument();
  });

  it("shows linked usage details and updates totals by date range and group", async () => {
    context.mocks.api(zeroUsageInsightContract.get, ({ query, respond }) => {
      if (query.range === "7d" && query.groupBy === "agent") {
        return respond(200, usageInsightLast7DaysAgentFixture);
      }
      if (query.range === "7d") {
        return respond(200, usageInsightLast7DaysSourceFixture);
      }
      return respond(200, usageInsightTodayFixture);
    });

    detachedSetupPage({ context, path: "/usage" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "Usage" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        within(
          screen.getByRole("region", { name: "Credits totals" }),
        ).getByText("credits"),
      ).toBeInTheDocument();
    });
    const creditsTotals = () => {
      return screen.getByRole("region", { name: "Credits totals" });
    };
    expect(within(creditsTotals()).getByText("1.3K")).toBeInTheDocument();
    expect(within(creditsTotals()).getByText("Today")).toBeInTheDocument();
    expect(within(creditsTotals()).getByText("Chat")).toBeInTheDocument();
    expect(within(creditsTotals()).getByText("Slack")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("My Schedule")).toBeInTheDocument();
      expect(screen.getByText("Chat with Agent")).toBeInTheDocument();
    });

    expect(
      queryAllByRoleFast("link").find((el) => {
        return /My Schedule/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();
    expect(
      queryAllByRoleFast("link").find((el) => {
        return /Chat with Agent/.test(el.textContent ?? "");
      }),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Date range"));
    click(screen.getByRole("option", { name: "Last 7 days" }));

    await waitFor(() => {
      expect(within(creditsTotals()).getByText("2.4K")).toBeInTheDocument();
      expect(
        within(creditsTotals()).getByText("Last 7 days"),
      ).toBeInTheDocument();
      expect(within(creditsTotals()).getByText("Email")).toBeInTheDocument();
      expect(screen.getByText("Daily Digest")).toBeInTheDocument();
      expect(screen.getByText("Roadmap Review")).toBeInTheDocument();
    });

    const chart = creditsTotals().querySelector("svg");
    if (!(chart instanceof SVGSVGElement)) {
      throw new Error("usage chart not found");
    }
    fireEvent.mouseMove(chart, { clientX: 300, clientY: 80 });

    await waitFor(() => {
      expect(within(creditsTotals()).getByText("Chat:")).toBeInTheDocument();
      expect(within(creditsTotals()).getByText("Slack:")).toBeInTheDocument();
      expect(within(creditsTotals()).getByText("Email:")).toBeInTheDocument();
    });

    fireEvent.mouseLeave(chart);

    await waitFor(() => {
      expect(
        within(creditsTotals()).queryByText("Chat:"),
      ).not.toBeInTheDocument();
    });

    click(tabByText("Agent"));

    await waitFor(() => {
      expect(
        within(creditsTotals()).getByText("Research Agent"),
      ).toBeInTheDocument();
      expect(within(creditsTotals()).getByText("Ops Bot")).toBeInTheDocument();
    });
    expect(
      within(creditsTotals()).queryByText("Email"),
    ).not.toBeInTheDocument();
    expect(
      within(creditsTotals()).queryByText("Slack"),
    ).not.toBeInTheDocument();
  });
});
