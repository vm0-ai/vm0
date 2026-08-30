import type { OrgMembersResponse } from "@okouai/api-contracts/contracts/org-members";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";
import { usageMembersContract } from "@okouai/api-contracts/contracts/usage";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const MOCK_NOW = "2026-03-01T01:00:00Z";
const SHORT_ALLOWANCE_RESET = "2026-03-01T05:00:00Z";
const WEEKLY_ALLOWANCE_RESET = "2026-03-08T00:00:00Z";

// Mirrors the allowance formatter: a window resetting today shows the clock,
// a later one shows the day.
function expectedAllowanceResetText(value: string): string {
  const date = new Date(value);
  const resetsToday = date.toDateString() === new Date(MOCK_NOW).toDateString();
  const formatted = new Intl.DateTimeFormat(
    "en-US",
    resetsToday
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(date);
  return `Resets ${formatted}`;
}

function mockBillingStatus(
  overrides: Partial<BillingStatusResponse> = {},
): void {
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier: "pro",
      credits: 12_000,
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
          credits: 8000,
        },
        {
          category: "payAsYouGo",
          label: "Purchased credits",
          credits: 4000,
        },
      ],
      creditGrants: [
        {
          id: "grant-pro",
          source: "subscription",
          label: "March Pro credits",
          amount: 10_000,
          remaining: 8000,
          createdAt: "2026-03-01T00:00:00Z",
          expiresAt: "2026-04-01T00:00:00Z",
        },
      ],
      usageAllowance: {
        windows: [
          {
            kind: "short",
            windowSeconds: 18_000,
            unitLimit: 5000,
            consumedUnits: 1250,
            remainingUnits: 3750,
            startsAt: "2026-03-01T00:00:00Z",
            expiresAt: SHORT_ALLOWANCE_RESET,
          },
          {
            kind: "weekly",
            windowSeconds: 604_800,
            unitLimit: 50_000,
            consumedUnits: 10_000,
            remainingUnits: 40_000,
            startsAt: "2026-03-01T00:00:00Z",
            expiresAt: WEEKLY_ALLOWANCE_RESET,
          },
        ],
      },
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
      ...overrides,
    });
  });
}

function mockUsageStory(): void {
  const orgMembers: OrgMembersResponse = {
    name: "Test Org",
    role: "admin",
    createdAt: "2026-01-01T00:00:00Z",
    members: [
      {
        userId: "test-user-123",
        email: "alice@example.com",
        firstName: "Alice",
        lastName: "Admin",
        imageUrl: "",
        role: "admin",
        joinedAt: "2026-01-01T00:00:00Z",
      },
      {
        userId: "user-bob",
        email: "bob@example.com",
        firstName: "Bob",
        lastName: "Member",
        imageUrl: "",
        role: "member",
        joinedAt: "2026-01-02T00:00:00Z",
      },
    ],
    pendingInvitations: [],
    membershipRequests: [],
  };
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  mockBillingStatus();
  context.mocks.api(orgMembersContract.members, ({ respond }) => {
    return respond(200, orgMembers);
  });
  context.mocks.api(usageMembersContract.get, ({ respond }) => {
    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00Z",
        end: "2026-04-01T00:00:00Z",
      },
      members: [
        {
          userId: "test-user-123",
          email: "alice@example.com",
          inputTokens: 12_000,
          outputTokens: 3000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          creditsCharged: 7500,
        },
        {
          userId: "user-bob",
          email: "bob@example.com",
          inputTokens: 8000,
          outputTokens: 1200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          creditsCharged: 2100,
        },
      ],
    });
  });
}

async function openCreditBalance(): Promise<void> {
  detachedSetupPage({
    context,
    path: "/?settings=usage",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Credit balance")[0]).toBeInTheDocument();
  });
}

async function openCreditUsage(): Promise<void> {
  detachedSetupPage({
    context,
    path: "/?settings=usage-records",
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Credit usage")[0]).toBeInTheDocument();
  });
}

describe("organization usage settings", () => {
  beforeEach(() => {
    mockNow(context.signal, new Date(MOCK_NOW));
  });

  it("shows the credit balance, allowance, and credit additions", async () => {
    mockUsageStory();
    await openCreditBalance();

    await waitFor(() => {
      expect(screen.getByText("12,000")).toBeInTheDocument();
    });
    const allowance = screen.getByTestId("usage-allowance-section");
    expect(allowance).toBeInTheDocument();
    expect(screen.getByText("Usage allowance")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("1w")).toBeInTheDocument();
    expect(screen.getByText("3,750 left")).toBeInTheDocument();
    expect(screen.getByText("40,000 left")).toBeInTheDocument();
    expect(
      screen.getByText(expectedAllowanceResetText(SHORT_ALLOWANCE_RESET)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(expectedAllowanceResetText(WEEKLY_ALLOWANCE_RESET)),
    ).toBeInTheDocument();
    expect(within(allowance).getAllByRole("progressbar")).toHaveLength(2);

    // The compact additions table keeps only the three values needed for
    // scanning; source and expiry details are available from each row tooltip.
    const grants = screen.getByTestId("credit-grants-section");
    expect(within(grants).getByText("Date")).toBeInTheDocument();
    expect(within(grants).getByText("Credits")).toBeInTheDocument();
    expect(within(grants).getByText("Left")).toBeInTheDocument();
    expect(within(grants).getByText("Mar 1, 2026")).toBeInTheDocument();
    expect(within(grants).getByText("+10,000")).toBeInTheDocument();
    expect(within(grants).getByText("8,000")).toBeInTheDocument();
    expect(within(grants).queryByText("March Pro credits")).toBeNull();
    expect(screen.queryByTestId("credit-grants-toggle")).toBeNull();
    expect(screen.queryByText("Pro credits")).toBeNull();
    expect(screen.queryByText("Purchased credits")).toBeNull();

    // Usage records moved to their own section.
    expect(screen.queryByText("Team usage")).toBeNull();
  });

  it("moves from the balance to the usage records through the section link", async () => {
    mockUsageStory();
    await openCreditBalance();

    await waitFor(() => {
      expect(
        screen.getByTestId("credit-balance-see-usage"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("credit-balance-see-usage"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Credit usage" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("usage-records-see-balance")).toBeNull();
  });

  it("sends the buy credits action to the billing section", async () => {
    mockUsageStory();
    await openCreditBalance();

    await waitFor(() => {
      expect(
        screen.getByTestId("credit-balance-buy-credits"),
      ).toBeInTheDocument();
    });
    click(screen.getByTestId("credit-balance-buy-credits"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Billing" }),
      ).toBeInTheDocument();
    });
  });

  it("hides the buy credits action when the plan cannot buy credits", async () => {
    mockUsageStory();
    mockBillingStatus({ canBuyCredits: false });
    await openCreditBalance();

    await waitFor(() => {
      expect(screen.getByTestId("credit-grants-section")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("credit-balance-buy-credits")).toBeNull();
  });

  it("draws the composition bar even when one category holds the balance", async () => {
    const user = userEvent.setup();
    mockUsageStory();
    mockBillingStatus({
      creditBreakdown: [
        {
          category: "payAsYouGo",
          label: "Purchased credits",
          credits: 12_000,
        },
      ],
    });
    await openCreditBalance();

    const segment = await screen.findByTestId(
      "credit-balance-segment-payAsYouGo",
    );
    await user.hover(segment);
    await expect(
      screen.findByText("Purchased credits — 12,000"),
    ).resolves.toBeInTheDocument();
  });

  it("labels far-future credit grant expiries as never expiring", async () => {
    const user = userEvent.setup();
    mockUsageStory();
    mockBillingStatus({
      creditGrants: [
        {
          id: "grant-custom",
          source: "atom_custom_credits",
          label: "Custom credits",
          amount: 12_000,
          remaining: 12_000,
          createdAt: "2026-03-01T00:00:00Z",
          expiresAt: "2999-12-31T23:59:59Z",
        },
      ],
    });
    await openCreditBalance();

    const grant = await screen.findByTestId("credit-grants-grant-custom");
    expect(screen.queryByText("Never expires")).toBeNull();
    await user.hover(grant);
    await expect(
      screen.findByText("Never expires"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Dec 31, 2999")).toBeNull();
  });

  it("shows workspace member usage in the credit usage section", async () => {
    mockUsageStory();
    await openCreditUsage();

    const teamUsageTab = queryAllByRoleFast("tab").find((element) => {
      return element.textContent === "Team usage";
    });
    if (!teamUsageTab) {
      throw new Error("Team usage tab not found");
    }
    click(teamUsageTab);
    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("7,500")).toBeInTheDocument();
    expect(screen.getByText("2,100")).toBeInTheDocument();
  });

  it("localizes the credit balance and credit additions in Portuguese", async () => {
    mockUsageStory();
    context.mocks.data.userPreferences({ locale: "pt-BR" });

    detachedSetupPage({
      context,
      path: "/?settings=usage",
    });

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
      expect(screen.getByText("12.000")).toBeInTheDocument();
      expect(screen.getByText("Franquia de uso")).toBeInTheDocument();
      expect(screen.getByText("3.750 restantes")).toBeInTheDocument();
    });

    const grants = screen.getByTestId("credit-grants-section");
    expect(within(grants).getByText("Data")).toBeInTheDocument();
    expect(within(grants).getByText("Créditos")).toBeInTheDocument();
    expect(within(grants).getByText("Restante")).toBeInTheDocument();
    expect(within(grants).getByText("+10.000")).toBeInTheDocument();
    expect(within(grants).getByText("8.000")).toBeInTheDocument();
  });

  it("localizes team usage in Portuguese", async () => {
    mockUsageStory();
    context.mocks.data.userPreferences({ locale: "pt-BR" });

    detachedSetupPage({
      context,
      path: "/?settings=usage-records",
    });

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
    });

    const teamUsageTab = await waitFor(() => {
      const tab = queryAllByRoleFast("tab").find((element) => {
        return element.textContent === "Uso da equipe";
      });
      if (!tab) {
        throw new Error("Portuguese team usage tab not found");
      }
      return tab;
    });
    click(teamUsageTab);
    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
      expect(screen.getByText("7.500")).toBeInTheDocument();
    });
  });
});
