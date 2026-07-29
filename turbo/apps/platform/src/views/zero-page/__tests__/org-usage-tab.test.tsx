import type { OrgMembersResponse } from "@vm0/api-contracts/contracts/org-members";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { formatSubscriptionUsageReset } from "../subscription-usage-format.ts";

const context = testContext();
const SHORT_ALLOWANCE_RESET = "2026-03-01T05:00:00Z";
const WEEKLY_ALLOWANCE_RESET = "2026-03-08T00:00:00Z";

function expectedAllowanceResetText(value: string): string {
  const reset = formatSubscriptionUsageReset(value);
  if (reset === null) {
    throw new Error("Expected usage allowance reset text");
  }
  if ("fallbackText" in reset) {
    return reset.fallbackText;
  }
  return `Resets ${reset.absoluteText}`;
}

function mockUsageStory(): void {
  const orgMembers: OrgMembersResponse = {
    slug: "test-org",
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
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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
    });
  });
  context.mocks.api(zeroOrgMembersContract.members, ({ respond }) => {
    return respond(200, orgMembers);
  });
  context.mocks.api(zeroUsageMembersContract.get, ({ respond }) => {
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

async function openUsageTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=usage" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Credit balance")[0]).toBeInTheDocument();
  });
}

describe("organization usage settings", () => {
  it("shows credit balance and workspace member usage", async () => {
    mockUsageStory();
    await openUsageTab();

    await waitFor(() => {
      expect(screen.getByText("12,000")).toBeInTheDocument();
    });
    expect(screen.getByText("Pro credits")).toBeInTheDocument();
    expect(screen.getByText("Purchased credits")).toBeInTheDocument();
    expect(screen.getByTestId("usage-allowance-section")).toBeInTheDocument();
    expect(screen.getByText("Usage allowance")).toBeInTheDocument();
    expect(screen.getByText("5h")).toBeInTheDocument();
    expect(screen.getByText("1w")).toBeInTheDocument();
    expect(screen.getByText("3,750 / 5,000 credits")).toBeInTheDocument();
    expect(screen.getByText("40,000 / 50,000 credits")).toBeInTheDocument();
    expect(
      screen.getByText(expectedAllowanceResetText(SHORT_ALLOWANCE_RESET)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(expectedAllowanceResetText(WEEKLY_ALLOWANCE_RESET)),
    ).toBeInTheDocument();
    expect(screen.queryByText("75%")).not.toBeInTheDocument();
    expect(screen.queryByText("80%")).not.toBeInTheDocument();
    expect(screen.queryByText("Expires Mar 1, 2026")).not.toBeInTheDocument();

    click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByText("March Pro credits")).toBeInTheDocument();

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

  it("localizes credit balances, grants, and team usage in Portuguese", async () => {
    mockUsageStory();
    context.mocks.data.userPreferences({ locale: "pt-BR" });

    detachedSetupPage({
      context,
      path: "/?settings=usage",
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
      expect(screen.getByText("12.000")).toBeInTheDocument();
      expect(screen.getByText("Plano Pro")).toBeInTheDocument();
      expect(screen.getByText("Pagamento conforme o uso")).toBeInTheDocument();
      expect(screen.getByText("Franquia de uso")).toBeInTheDocument();
      expect(screen.getByText("3.750 / 5.000 créditos")).toBeInTheDocument();
    });

    click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByText("March Pro credits")).toBeInTheDocument();

    const teamUsageTab = queryAllByRoleFast("tab").find((element) => {
      return element.textContent === "Uso da equipe";
    });
    if (!teamUsageTab) {
      throw new Error("Portuguese team usage tab not found");
    }
    click(teamUsageTab);
    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
      expect(screen.getByText("7.500")).toBeInTheDocument();
    });
  });
});
