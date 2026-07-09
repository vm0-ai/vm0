import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import {
  zeroUsageRecordContract,
  type UsageRecordRow,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function usageRows(): UsageRecordRow[] {
  return [
    {
      source: "chat",
      threadId: "thread-planning",
      runId: null,
      title: "Quarterly planning chat",
      credits: 980,
      tokens: 2200,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-03-21T10:00:00Z",
    },
    {
      source: "slack",
      threadId: null,
      runId: "run-slack-follow-up",
      title: "Slack customer follow-up",
      credits: 2400,
      tokens: 5100,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-03-20T10:00:00Z",
    },
    ...Array.from({ length: 18 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return {
        source: "automation",
        threadId: `thread-scheduled-${index}`,
        runId: null,
        title: `Scheduled digest ${index + 1}`,
        credits: 100 + index,
        tokens: 1000 + index,
        breakdown: [],
        member: null,
        lastActivityAt: `2026-03-${day}T10:00:00Z`,
      } satisfies UsageRecordRow;
    }),
    {
      source: "cli",
      threadId: null,
      runId: "run-cli-audit",
      title: "Extended CLI audit",
      credits: 3100,
      tokens: 7300,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-02-28T10:00:00Z",
    },
  ];
}

function usageRow(args: {
  readonly title: string;
  readonly credits: number;
  readonly runId: string;
}): UsageRecordRow {
  return {
    source: "chat",
    threadId: null,
    runId: args.runId,
    title: args.title,
    credits: args.credits,
    tokens: 1000,
    breakdown: [],
    member: null,
    lastActivityAt: "2026-03-21T10:00:00Z",
  };
}

function mockBillingStatus(): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [
        {
          category: "plan",
          tier: "pro",
          label: "Pro credits",
          credits: 10_000,
        },
        {
          category: "promotional",
          label: "Launch bonus",
          credits: 2500,
        },
      ],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
}

function mockPersonalUsageStory(): string[] {
  const rows = usageRows();
  const requestedRanges: string[] = [];

  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "member",
  });
  mockBillingStatus();
  context.mocks.api(zeroUsageRecordContract.get, ({ query, respond }) => {
    requestedRanges.push(query.range);
    const offset = (query.page - 1) * query.pageSize;

    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
      rows: rows.slice(offset, offset + query.pageSize),
      totalCredits: rows.reduce((sum, row) => {
        return sum + row.credits;
      }, 0),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: rows.length,
      },
    });
  });
  return requestedRanges;
}

async function openUsageSettings(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
  });
}

describe("personal usage settings", () => {
  it("shows personal usage, loads more, and changes the usage range", async () => {
    const requestedRanges = mockPersonalUsageStory();
    await openUsageSettings();

    await waitFor(() => {
      expect(screen.getByText("Quarterly planning chat")).toBeInTheDocument();
      expect(screen.getByText("Slack customer follow-up")).toBeInTheDocument();
    });
    expect(screen.getByText("980")).toBeInTheDocument();
    expect(screen.queryByText("Extended CLI audit")).not.toBeInTheDocument();
    expect(screen.queryByText("All sources")).not.toBeInTheDocument();
    expect(requestedRanges).toContain("today");

    click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText("Extended CLI audit")).toBeInTheDocument();
    });

    click(screen.getByText("Today"));
    click(await screen.findByText("Last 7 days"));

    await waitFor(() => {
      expect(screen.getByText("Last 7 days")).toBeInTheDocument();
      expect(requestedRanges).toContain("7d");
    });
  });

  it("keeps keyboard focus styling on the usage title instead of the row", async () => {
    mockPersonalUsageStory();
    await openUsageSettings();

    const titleLink = await screen.findByText("Quarterly planning chat");

    titleLink.focus();
    expect(titleLink).toHaveFocus();
    expect(titleLink.parentElement?.closest("a")).toBeNull();
    expect(titleLink).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-inset",
    );
  });

  it("refreshes personal usage when billing realtime changes", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });
    mockBillingStatus();
    let usageRequests = 0;
    context.mocks.api(zeroUsageRecordContract.get, ({ query, respond }) => {
      usageRequests += 1;
      const rows =
        usageRequests === 1
          ? [
              usageRow({
                title: "Initial usage row",
                credits: 100,
                runId: "run-initial",
              }),
            ]
          : [
              usageRow({
                title: "Realtime refreshed usage",
                credits: 450,
                runId: "run-refreshed",
              }),
            ];
      return respond(200, {
        period: {
          start: "2026-03-01T00:00:00.000Z",
          end: "2026-04-01T00:00:00.000Z",
        },
        rows,
        totalCredits: rows.reduce((sum, row) => {
          return sum + row.credits;
        }, 0),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: rows.length,
        },
      });
    });

    await openUsageSettings();

    await waitFor(() => {
      expect(screen.getByText("Initial usage row")).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });

    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(screen.getByText("Realtime refreshed usage")).toBeInTheDocument();
      expect(screen.queryByText("Initial usage row")).not.toBeInTheDocument();
    });
  });
});
