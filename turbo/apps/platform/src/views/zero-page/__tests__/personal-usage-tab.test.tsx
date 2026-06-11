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
        source: "schedule",
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

function mockPersonalUsageStory(): void {
  const rows = usageRows();

  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "member",
  });
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
    });
  });
  context.mocks.api(zeroUsageRecordContract.get, ({ query, respond }) => {
    const filteredRows = query.source
      ? rows.filter((row) => {
          return row.source === query.source;
        })
      : rows;
    const offset = (query.page - 1) * query.pageSize;

    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
      rows: filteredRows.slice(offset, offset + query.pageSize),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: filteredRows.length,
      },
    });
  });
}

async function openUsageSettings(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("credit-balance-info")).toBeInTheDocument();
  });
}

describe("personal usage settings", () => {
  it("shows personal usage, loads more, and filters by source", async () => {
    mockPersonalUsageStory();
    await openUsageSettings();

    await waitFor(() => {
      expect(screen.getByText("12,500")).toBeInTheDocument();
      expect(screen.getByText("Quarterly planning chat")).toBeInTheDocument();
      expect(screen.getByText("Slack customer follow-up")).toBeInTheDocument();
    });
    expect(screen.getByText("980 credits")).toBeInTheDocument();
    expect(screen.queryByText("Extended CLI audit")).not.toBeInTheDocument();

    click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText("Extended CLI audit")).toBeInTheDocument();
    });

    click(screen.getByText("All sources"));
    click(await screen.findByText("Slack"));

    await waitFor(() => {
      expect(screen.getByText("Slack customer follow-up")).toBeInTheDocument();
      expect(
        screen.queryByText("Quarterly planning chat"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Extended CLI audit")).not.toBeInTheDocument();
    });

    click(screen.getByText("Slack"));
    click(await screen.findByText("Telegram"));

    await waitFor(() => {
      expect(
        screen.getByText("No usage from this source yet."),
      ).toBeInTheDocument();
    });
  });
});
