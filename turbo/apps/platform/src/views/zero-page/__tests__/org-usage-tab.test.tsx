import type { OrgMembersResponse } from "@vm0/api-contracts/contracts/org-members";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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

    click(screen.getByTestId("credit-grants-toggle"));
    expect(screen.getByText("March Pro credits")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Alice Admin")).toBeInTheDocument();
      expect(screen.getByText("bob@example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("7,500")).toBeInTheDocument();
    expect(screen.getByText("2,100")).toBeInTheDocument();
  });
});
