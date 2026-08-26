import {
  billingAutoRechargeContract,
  billingUsagePackCatalogContract,
  billingUsagePackCheckoutContract,
  billingUsagePackManagementContract,
  billingUsagePackMigrationContract,
  billingConcurrencyCheckoutContract,
  billingConcurrencySubscriptionContract,
  billingCreditCheckoutContract,
  billingDowngradeContract,
  billingPortalContract,
  billingRestoreContract,
  billingStatusContract,
  type BillingStatusResponse,
  type CreditCheckoutRequest,
  type UsagePackMigrationStateResponse,
} from "@okouai/api-contracts/contracts/billing";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "@okouai/ui/components/ui/sonner";
import { describe, expect, it, vi, type Mock } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function queryButtonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement | undefined {
  return queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function subscriptionComparisonTrigger(
  container: ParentNode = document.body,
): HTMLElement {
  const trigger = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate
      .getAttribute("aria-label")
      ?.startsWith("Subscription comparison:");
  });
  if (!trigger) {
    throw new Error("Subscription comparison trigger not found");
  }
  return trigger;
}

async function hoverSubscriptionComparison(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.hover(subscriptionComparisonTrigger());
  return await screen.findByRole("tooltip");
}

function activeProBillingStatus(): BillingStatusResponse {
  return {
    tier: "pro",
    credits: 25_000,
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
        credits: 20_000,
      },
      {
        category: "payAsYouGo",
        label: "Purchased credits",
        credits: 5000,
      },
    ],
    creditGrants: [],
    concurrencyLimit: 2,
    concurrencySubscriptions: [],
    concurrencyUnitAmountCents: 10_000,
  };
}

function activeTeamBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "team",
    credits: 130_000,
    currentPeriodEnd: "2026-05-01T00:00:00Z",
    concurrencyLimit: 10,
    creditBreakdown: [
      {
        category: "plan",
        tier: "team",
        label: "Team credits",
        credits: 120_000,
      },
      {
        category: "payAsYouGo",
        label: "Purchased credits",
        credits: 10_000,
      },
    ],
  };
}

function activeCustomBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "custom",
    credits: 0,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    hasSubscription: false,
    creditBreakdown: [],
    concurrencyLimit: 10,
  };
}

function noActiveBillingStatus(): BillingStatusResponse {
  return {
    tier: "pro-suspend",
    credits: 0,
    onboardingPaymentPending: false,
    subscriptionStatus: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: false,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: {
      expiringNextCycle: 0,
      nextExpiryDate: null,
    },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 0,
    concurrencySubscriptions: [],
  };
}

function usagePackCatalogResponse() {
  return {
    usagePacks: [
      {
        usagePackUsd: 20 as const,
        priceUsd: 20,
        purchasedCredits: 20_000,
        bonusCredits: 1234,
        totalCredits: 21_234,
      },
      {
        usagePackUsd: 50 as const,
        priceUsd: 50,
        purchasedCredits: 50_000,
        bonusCredits: 4321,
        totalCredits: 54_321,
      },
      {
        usagePackUsd: 100 as const,
        priceUsd: 100,
        purchasedCredits: 100_000,
        bonusCredits: 9999,
        totalCredits: 109_999,
      },
      {
        usagePackUsd: 200 as const,
        priceUsd: 200,
        purchasedCredits: 200_000,
        bonusCredits: 30_000,
        totalCredits: 230_000,
      },
    ],
  };
}

function mockBillingStory(): {
  readonly creditCheckoutRequest: () => CreditCheckoutRequest | null;
} {
  let billingStatus = activeProBillingStatus();
  let creditCheckoutRequest: CreditCheckoutRequest | null = null;

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(billingAutoRechargeContract.update, ({ body, respond }) => {
    billingStatus = {
      ...billingStatus,
      autoRecharge: {
        enabled: body.enabled,
        threshold: body.enabled ? (body.threshold ?? null) : null,
        amount: body.enabled ? (body.amount ?? null) : null,
      },
    };
    return respond(200, billingStatus.autoRecharge);
  });
  context.mocks.api(
    billingCreditCheckoutContract.create,
    ({ body, respond }) => {
      creditCheckoutRequest = body;
      return respond(200, {
        url: "https://billing.stripe.com/checkout/credit-purchase",
      });
    },
  );
  context.mocks.api(billingDowngradeContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: true,
      canRestorePlan: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-04-01T00:00:00Z",
      },
    };
    return respond(200, {
      success: true,
      effectiveDate: "2026-04-01T00:00:00Z",
    });
  });
  context.mocks.api(billingRestoreContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: false,
      canRestorePlan: false,
      scheduledChange: null,
    };
    return respond(200, { status: "restored" });
  });
  return {
    creditCheckoutRequest: () => {
      return creditCheckoutRequest;
    },
  };
}

async function openBillingTab(path = "/?settings=billing"): Promise<void> {
  detachedSetupPage({
    context,
    path,
  });
  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Billing" }),
    ).toBeInTheDocument();
  });
}

function inAppBillingPreviewFields() {
  return {
    supportsInAppPreview: true as const,
    returnUrl: new URL(
      window.location.pathname,
      window.location.origin,
    ).toString(),
  };
}

function installScrollIntoViewMock(): Mock<HTMLElement["scrollIntoView"]> {
  const scrollIntoView = vi.fn<HTMLElement["scrollIntoView"]>();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

async function openSettingsFromAccountMenu(
  userName = "Test User",
): Promise<HTMLElement> {
  const accountName = await screen.findByText(userName);
  const accountButton = accountName.closest("button");
  if (!accountButton) {
    throw new Error("Account menu trigger not found");
  }
  click(accountButton);
  const menu = await screen.findByRole("menu");
  click(within(menu).getByText("Settings"));
  return screen.findByRole("dialog", { name: "Settings" });
}

async function waitForAnimationFrame(): Promise<void> {
  const frame = createDeferredPromise<void>(context.signal);
  window.requestAnimationFrame(() => {
    frame.resolve(undefined);
  });
  await frame.promise;
}

describe("organization billing settings", () => {
  it("configures member usage", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Usage Pack Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.data.orgMembers({
      name: "Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
        {
          userId: "user_2",
          email: "sam@example.com",
          firstName: "Sam",
          lastName: "Lee",
          imageUrl: "",
          role: "member",
          joinedAt: "2026-01-02T00:00:00Z",
        },
      ],
      pendingInvitations: [
        {
          id: "invitation_1",
          email: "pending@example.com",
          role: "member",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });
    click(buttonByText("Upgrade"));

    const choosePlanHeading = await screen.findByRole("heading", {
      name: "Choose a plan",
    });
    expect(choosePlanHeading).toBeInTheDocument();
    // The plan steps are a dialog over the billing tab, not a page that
    // replaces it, so the plan the workspace is deciding against stays visible.
    expect(screen.getByText("No active plan")).toBeInTheDocument();
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    const teamPlan = screen.getByRole("article", { name: "Team plan" });
    // The figure is a floor, not a fixed total: a workspace pays the plan plus
    // one package for every member, and packages run $20 to $200.
    expect(proPlan).toHaveTextContent("from $20/month");
    expect(
      within(proPlan).getByText("Plan $0 · member packages $20–$200 each"),
    ).toBeInTheDocument();
    expect(teamPlan).toHaveTextContent("from $180/month");
    expect(
      within(teamPlan).getByText("Plan $160 · member packages $20–$200 each"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Every member needs a package. You pick each member's package in the next step.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Member usage" }),
    ).not.toBeInTheDocument();

    expect(
      within(proPlan).getByText("Everyday agent work, priced per member."),
    ).toBeInTheDocument();
    expect(within(proPlan).queryByText("20,000 credits / month")).toBeNull();
    expect(within(proPlan).queryByText("Pay as you go after that")).toBeNull();
    expect(
      within(teamPlan).getByText(
        "For a team that keeps agents running all day.",
      ),
    ).toBeInTheDocument();
    expect(within(teamPlan).queryByText("120,000 credits / month")).toBeNull();

    // Pro carries the whole list.
    expect(within(proPlan).getByText("Included")).toBeInTheDocument();
    for (const item of [
      "2 agents running at once",
      "Claude Opus 5, GPT 5.6 Sol, DeepSeek V4 Pro",
      "Bring your own LLM keys",
      "Scheduled and event automations",
      "Video and avatar generation",
      "Built-in SEO, lead, web, and market data",
      "Slack and Telegram integration",
      "Voice input, 300 requests and 200 minutes a day",
      "Email support",
    ]) {
      expect(within(proPlan).getByText(item)).toBeInTheDocument();
    }

    /* Concurrency, webhooks and the voice caps are the real entitlement
       differences; the middle rows are shared capability the label inherits with
       "Everything in Pro", each phrased as an outcome rather than a setting. */
    expect(
      within(teamPlan).getByText("Everything in Pro, built for teams"),
    ).toBeInTheDocument();
    for (const item of [
      "10 agents running at once",
      "Add more concurrency any time",
      "One agent can run a whole team of agents",
      "Start a run from any system with one webhook",
      "Watch an agent's live browser and take the wheel",
      "Agents drive real apps on your desktop",
      "More custom connectors & channel integration",
      "Voice input, 500 requests and 500 minutes a day",
      "Priority support",
    ]) {
      expect(within(teamPlan).getByText(item)).toBeInTheDocument();
    }
    for (const item of [
      "2 agents running at once",
      "Claude Opus 5, GPT 5.6 Sol, DeepSeek V4 Pro",
      "Bring your own LLM keys",
      "Scheduled and event automations",
      "Video and avatar generation",
      "Built-in SEO, lead, web, and market data",
      "Slack and Telegram integration",
      "Email support",
    ]) {
      expect(within(teamPlan).queryByText(item)).toBeNull();
    }

    click(buttonByText("Start with Team", teamPlan));

    const configurePackagesHeading = await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(configurePackagesHeading).toBeInTheDocument();

    const memberUsage = screen.getByRole("group", {
      name: "Member usage",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("alex@example.com"),
    ).toBeInTheDocument();
    expect(within(memberUsage).getByText("Sam Lee")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("sam@example.com"),
    ).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("pending@example.com"),
    ).toBeInTheDocument();
    expect(within(memberUsage).getByText("Pending")).toBeInTheDocument();
    const alexUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    const samUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for Sam Lee",
    });
    const pendingUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for pending@example.com",
    });
    expect(alexUsage).toHaveTextContent("21,234 credits · 6% off");
    expect(samUsage).toHaveTextContent("21,234 credits · 6% off");
    expect(pendingUsage).toHaveTextContent("21,234 credits · 6% off");
    expect(alexUsage).not.toBeDisabled();
    expect(samUsage).not.toBeDisabled();
    expect(pendingUsage).not.toBeDisabled();
    expect(
      within(memberUsage).queryByText(
        "20,000 purchased credits + 1,234 bonus credits",
      ),
    ).not.toBeInTheDocument();
    expect(
      within(memberUsage).getByText(
        "One package per member. Any overage uses pay-as-you-go credits.",
      ),
    ).toBeInTheDocument();
    expect(within(memberUsage).getByText("Team plan")).toBeInTheDocument();
    expect(within(memberUsage).getByText("$160")).toBeInTheDocument();
    expect(memberUsage).toHaveTextContent(
      "Monthly total63,702 credits · 3,702 bonus$220/month",
    );
    expect(buttonByText("Upgrade to Team", orderSummary)).not.toBeDisabled();

    click(alexUsage);
    expect(
      screen.queryByRole("option", { name: "Pay as you go" }),
    ).not.toBeInTheDocument();
    const alexFiftyDollarPack = screen.getByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    });
    click(alexFiftyDollarPack);
    expect(memberUsage).toHaveTextContent("$250/month");

    click(pendingUsage);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );

    expect(memberUsage).toHaveTextContent(
      "Monthly total185,554 credits · 15,554 bonus$330/month",
    );
    expect(
      within(memberUsage).queryByText(
        "100,000 purchased credits + 9,999 bonus credits",
      ),
    ).not.toBeInTheDocument();
    expect(alexUsage).not.toBeDisabled();
    expect(samUsage).not.toBeDisabled();
    expect(pendingUsage).not.toBeDisabled();

    click(screen.getByLabelText("Back"));
    const returnedChoosePlanHeading = await screen.findByRole("heading", {
      name: "Choose a plan",
    });
    expect(returnedChoosePlanHeading).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Member usage" }),
    ).not.toBeInTheDocument();

    const returnedTeamPlan = screen.getByRole("article", {
      name: "Team plan",
    });
    click(buttonByText("Start with Team", returnedTeamPlan));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });

    // The plan steps are modal, so the settings dialog underneath is inert
    // until the step dialog closes.
    const packagesDialog = screen.getByRole("dialog", {
      name: "Configure member packages",
    });
    click(within(packagesDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Configure member packages" }),
      ).not.toBeInTheDocument();
    });
    // Closing the flow lands back on the billing overview it was opened from.
    expect(screen.getByText("No active plan")).toBeInTheDocument();
    expect(buttonByText("Upgrade")).toBeInTheDocument();

    const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
    click(within(settingsDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
    });

    const reopenedDialog = await openSettingsFromAccountMenu("Alex Chen");
    click(buttonByText("Billing", reopenedDialog));
    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });
    click(buttonByText("Upgrade"));
    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();

    const reopenedTeamPlan = screen.getByRole("article", {
      name: "Team plan",
    });
    click(buttonByText("Start with Team", reopenedTeamPlan));

    const resetMemberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(
      within(resetMemberUsage).getByRole("combobox", {
        name: "Usage for Alex Chen",
      }),
    ).toHaveTextContent("21,234 credits · 6% off");
    expect(
      within(resetMemberUsage).getByRole("combobox", {
        name: "Usage for pending@example.com",
      }),
    ).toHaveTextContent("21,234 credits · 6% off");
    expect(resetMemberUsage).toHaveTextContent("$220/month");
    const resetOrderSummary = screen.getByRole("region", {
      name: "Order summary",
    });

    const resetAlexUsage = within(resetMemberUsage).getByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    click(resetAlexUsage);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    const resetPendingUsage = within(resetMemberUsage).getByRole("combobox", {
      name: "Usage for pending@example.com",
    });
    click(resetPendingUsage);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    context.mocks.api(
      billingUsagePackCheckoutContract.create,
      ({ body, respond }) => {
        expect(body.memberUsagePacks).toStrictEqual([
          { memberId: "user_1", usagePackUsd: 50 },
          { memberId: "user_2", usagePackUsd: 20 },
          { memberId: "invitation_1", usagePackUsd: 100 },
        ]);
        return respond(200, {
          url: "https://checkout.stripe.com/test-usage-pack",
        });
      },
    );

    click(buttonByText("Upgrade to Team", resetOrderSummary));
    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test-usage-pack",
      );
    });
  });

  it("lets admins add packages for active members missing an allocation", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Managed Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Managed Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
        {
          userId: "user_2",
          email: "sam@example.com",
          firstName: "Sam",
          lastName: "Lee",
          imageUrl: "",
          role: "member",
          joinedAt: "2026-01-02T00:00:00Z",
        },
      ],
      pendingInvitations: [
        {
          id: "invitation_paid_pending",
          email: "paid.pending@example.com",
          role: "member",
          createdAt: "2026-01-03T00:00:00Z",
          usagePackUsd: 100,
        },
      ],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        supportsMemberAdditions: true,
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 20,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "user_2", usagePackUsd: 50 },
          ],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 2500,
          immediateCreditGrant: {
            purchasedCredits: 25_000,
            bonusCredits: 2160,
            totalCredits: 27_160,
            expiresAt: "2026-04-01T00:00:00Z",
          },
          nextRecurringAmountCents: 7000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));
    const memberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
    expect(within(memberUsage).getByText("Sam Lee")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("paid.pending@example.com"),
    ).toBeInTheDocument();
    expect(within(memberUsage).getByText("Pending")).toBeInTheDocument();
    const paidPendingUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for paid.pending@example.com",
    });
    expect(paidPendingUsage).toHaveTextContent("109,999 credits · 9% off");
    expect(paidPendingUsage).toBeDisabled();
    const samUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for Sam Lee",
    });
    click(samUsage);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    const confirmButton = buttonByText("Confirm", orderSummary);
    click(confirmButton);
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(reviewDialog).toBeInTheDocument();
    expect(confirmButton).toHaveTextContent("Updating...");
    expect(confirmButton).toBeDisabled();
  });

  it("labels the current plan as legacy and offers both new plans", async () => {
    const migrationReady = createDeferredPromise<void>(context.signal);
    context.mocks.data.org({
      id: "org_1",
      name: "Legacy Team Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Legacy Team Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(
      billingUsagePackMigrationContract.get,
      async ({ respond }) => {
        await migrationReady.promise;
        return respond(200, {
          tier: "team",
          targetTier: null,
          status: "eligible",
          migrationId: null,
          effectiveAt: "2026-09-01T00:00:00.000Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Team plan");
    click(buttonByText("Compare all plans"));

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();

    migrationReady.resolve(undefined);

    const choosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    expect(
      within(choosePlanDialog).getByText("Step 1 of 3"),
    ).toBeInTheDocument();
    expect(screen.getByText("Legacy")).toBeInTheDocument();
    const proPlan = within(choosePlanDialog).getByRole("article", {
      name: "Pro plan",
    });
    const teamPlan = within(choosePlanDialog).getByRole("article", {
      name: "Team plan",
    });
    expect(buttonByText("Convert plan", proPlan)).toBeEnabled();
    expect(buttonByText("Convert plan", teamPlan)).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "Configure member packages" }),
    ).not.toBeInTheDocument();

    click(
      buttonByText(
        "Convert plan",
        screen.getByRole("article", { name: "Pro plan" }),
      ),
    );

    const configurePackagesDialog = await screen.findByRole("dialog", {
      name: "Configure member packages",
    });
    expect(
      within(configurePackagesDialog).getByText("Step 2 of 3"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    const comparison = within(await hoverSubscriptionComparison()).getByRole(
      "table",
      {
        name: "Current and new subscription comparison",
      },
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Plan Team Legacy Pro/u,
      }),
    ).toBeInTheDocument();
    expect(within(comparison).getByText("Monthly total")).toBeInTheDocument();

    click(within(configurePackagesDialog).getByLabelText("Back"));
    const returnedChoosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    click(within(returnedChoosePlanDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Choose a plan" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Legacy")).toBeInTheDocument();
    expect(
      screen.queryByText("Move to member packages"),
    ).not.toBeInTheDocument();
    expect(buttonByText("Convert plan")).toBeEnabled();

    click(screen.getByText("Downgrade"));
    const downgradeDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(downgradeDialog).getByText("Downgrade to No plan?"),
    ).toBeInTheDocument();
    expect(
      within(downgradeDialog).queryByText("Choose which plan to downgrade to."),
    ).not.toBeInTheDocument();
    expect(within(downgradeDialog).queryByText("Pro")).not.toBeInTheDocument();
    click(buttonByText("Cancel", downgradeDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Downgrade plan" }),
      ).not.toBeInTheDocument();
    });

    click(buttonByText("Convert plan"));
    await screen.findByRole("dialog", { name: "Choose a plan" });
  });

  it("shows conversion without upgrade for a legacy Pro plan", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Legacy Pro Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        targetTier: null,
        status: "eligible",
        migrationId: null,
        effectiveAt: "2026-09-01T00:00:00.000Z",
        hostedInvoiceUrl: null,
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
    });

    await screen.findByText("Legacy");
    expect(buttonByText("Convert plan")).toBeEnabled();
    expect(queryButtonByText("Upgrade")).toBeUndefined();
  });

  it("does not offer a second checkout when migration is unavailable", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Paid Pro Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          message: "Usage pack subscription not found",
          code: "NOT_FOUND",
        },
      });
    });
    context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          message: "Legacy subscription migration is not available",
          code: "NOT_FOUND",
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));

    const teamPlan = await screen.findByRole("article", { name: "Team plan" });
    expect(buttonByText("Start with Team", teamPlan)).toBeDisabled();
  });

  it.each([
    { planName: "Pro", status: activeProBillingStatus() },
    {
      planName: "Team",
      status: activeTeamBillingStatus(),
    },
  ])(
    "lets an Atom-granted $planName workspace manage its current plan",
    async ({ planName, status }) => {
      context.mocks.data.org({
        id: "org_1",
        name: `Atom ${planName} Org`,
        role: "admin",
      });
      context.mocks.data.orgMembers({
        name: `Atom ${planName} Org`,
        role: "admin",
        members: [
          {
            userId: "user_1",
            email: "alex@example.com",
            firstName: "Alex",
            lastName: "Chen",
            imageUrl: "",
            role: "admin",
            joinedAt: "2026-01-01T00:00:00Z",
          },
        ],
        pendingInvitations: [],
        membershipRequests: [],
        createdAt: "2026-01-01T00:00:00Z",
      });
      context.mocks.api(billingStatusContract.get, ({ respond }) => {
        return respond(200, {
          ...status,
          subscriptionStatus: "atom_grant",
          hasSubscription: false,
          memberInviteUsagePackRequired: true,
          cancelAtPeriodEnd: true,
          scheduledChange: {
            type: "cancel",
            targetTier: "limited-free-1",
            effectiveDate: status.currentPeriodEnd,
          },
          canRestorePlan: false,
        });
      });
      context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      });
      context.mocks.api(
        billingUsagePackManagementContract.get,
        ({ respond }) => {
          return respond(404, {
            error: {
              message: "Usage pack subscription not found",
              code: "NOT_FOUND",
            },
          });
        },
      );
      context.mocks.api(
        billingUsagePackMigrationContract.get,
        ({ respond }) => {
          return respond(404, {
            error: {
              message: "Legacy subscription migration is not available",
              code: "NOT_FOUND",
            },
          });
        },
      );

      detachedSetupPage({
        context,
        path: "/?settings=billing",
        user: {
          id: "user_1",
          fullName: "Alex Chen",
          email: "alex@example.com",
        },
      });

      await screen.findByText(`${planName} plan`);
      click(buttonByText("Compare all plans"));
      const plan = await screen.findByRole("article", {
        name: `${planName} plan`,
      });
      expect(buttonByText("Manage", plan)).toBeEnabled();
      click(buttonByText("Manage", plan));

      const memberUsage = await screen.findByRole("group", {
        name: "Member usage",
      });
      expect(
        within(memberUsage).getByRole("combobox", {
          name: "Usage for Alex Chen",
        }),
      ).toHaveTextContent("21,234 credits");
      const orderSummary = screen.getByRole("region", {
        name: "Order summary",
      });
      expect(
        buttonByText("Configure member packages", orderSummary),
      ).toBeEnabled();
      expect(
        within(orderSummary).queryByText(`Upgrade to ${planName}`),
      ).not.toBeInTheDocument();
    },
  );

  it("previews and confirms an in-place legacy Team migration", async () => {
    const successToast = vi.spyOn(toast, "success");
    let migrationState: UsagePackMigrationStateResponse = {
      tier: "team",
      targetTier: null,
      status: "eligible",
      migrationId: null,
      effectiveAt: "2026-09-01T00:00:00.000Z",
      hostedInvoiceUrl: null,
    };
    context.mocks.data.org({
      id: "org_1",
      name: "Legacy Team Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Legacy Team Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [
        {
          id: "invitation_1",
          email: "pending@example.com",
          role: "member",
          createdAt: "2026-01-03T00:00:00Z",
        },
      ],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(404, {
        error: {
          message: "Usage pack subscription not found",
          code: "NOT_FOUND",
        },
      });
    });
    context.mocks.api(billingUsagePackMigrationContract.get, ({ respond }) => {
      return respond(200, migrationState);
    });
    context.mocks.api(
      billingUsagePackMigrationContract.preview,
      ({ body, respond }) => {
        expect(body.targetTier).toBe("team");
        expect(body.memberUsagePacks).toStrictEqual([
          { memberId: "user_1", usagePackUsd: 20 },
          { memberId: "invitation_1", usagePackUsd: 50 },
        ]);
        migrationState = {
          ...migrationState,
          status: "previewed",
          targetTier: "team",
          migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
        };
        return respond(200, {
          migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
          tier: "team",
          targetTier: "team",
          currentRecurringAmountCents: 20_000,
          nextRecurringAmountCents: 22_950,
          recurringDifferenceCents: 2950,
          currency: "usd",
          purchasedCredits: 70_000,
          bonusCredits: 5555,
          totalCredits: 75_555,
          effectiveAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-03-16T00:30:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackMigrationContract.confirm,
      ({ body, params, respond }) => {
        expect(body).toStrictEqual({});
        expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
        migrationState = {
          ...migrationState,
          status: "scheduled",
          configuration: {
            tier: "team",
            memberUsagePacks: [
              { memberId: "user_1", usagePackUsd: 20 },
              { memberId: "invitation_1", usagePackUsd: 50 },
            ],
            recurringAmountCents: 22_950,
            currency: "usd",
          },
        };
        return respond(200, {
          status: "scheduled",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          hostedInvoiceUrl: null,
        });
      },
    );
    context.mocks.api(
      billingUsagePackMigrationContract.previewRevision,
      ({ body, params, respond }) => {
        expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "invitation_1", usagePackUsd: 50 },
          ],
        });
        return respond(200, {
          migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
          tier: "team",
          targetTier: "pro",
          currentRecurringAmountCents: 22_950,
          nextRecurringAmountCents: 7000,
          recurringDifferenceCents: -15_950,
          currency: "usd",
          purchasedCredits: 70_000,
          bonusCredits: 5555,
          totalCredits: 75_555,
          effectiveAt: "2026-09-01T00:00:00.000Z",
          expiresAt: "2026-03-16T00:30:00Z",
          previewToken: "signed-revision-preview",
        });
      },
    );
    context.mocks.api(
      billingUsagePackMigrationContract.confirmRevision,
      ({ body, params, respond }) => {
        expect(params.migrationId).toBe("3ea4b7cf-d71e-45dc-8273-8bc8b9712490");
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "invitation_1", usagePackUsd: 50 },
          ],
          previewToken: "signed-revision-preview",
        });
        migrationState = {
          ...migrationState,
          targetTier: "pro",
          status: "scheduled",
          configuration: {
            tier: "pro",
            memberUsagePacks: [
              { memberId: "user_1", usagePackUsd: 20 },
              { memberId: "invitation_1", usagePackUsd: 50 },
            ],
            recurringAmountCents: 7000,
            currency: "usd",
          },
        };
        return respond(200, {
          status: "scheduled",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Team plan");
    click(buttonByText("Compare all plans"));
    const choosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    click(
      buttonByText(
        "Convert plan",
        within(choosePlanDialog).getByRole("article", { name: "Team plan" }),
      ),
    );

    const configurePackagesDialog = await screen.findByRole("dialog", {
      name: "Configure member packages",
    });
    expect(
      within(configurePackagesDialog).getByText("Step 2 of 3"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
    const memberUsage = screen.getByRole("group", { name: "Member usage" });
    expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("pending@example.com"),
    ).toBeInTheDocument();
    const pendingUsage = within(memberUsage).getByRole("combobox", {
      name: "Usage for pending@example.com",
    });
    click(pendingUsage);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );

    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(
      within(orderSummary).queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    const orderComparison = within(
      await hoverSubscriptionComparison(),
    ).getByRole("table", {
      name: "Current and new subscription comparison",
    });
    expect(
      within(orderComparison).getByRole("row", {
        name: /Plan Team Legacy Team/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderComparison).getByRole("row", {
        name: /Member packages \$0 \$70/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderComparison).getByRole("row", {
        name: /Concurrent slots 10 10/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderComparison).getByRole("row", {
        name: /Purchased credits 120,000 70,000/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderComparison).getByRole("row", {
        name: /Bonus credits 0 5,555/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderComparison).getByRole("row", {
        name: /Monthly total \$200\/month \$230\/month/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(orderSummary).queryByText("Monthly difference"),
    ).not.toBeInTheDocument();
    const conversionNotice = within(orderSummary).getByRole("status", {
      name: "Convert plan",
    });
    expect(conversionNotice).toBeVisible();
    expect(conversionNotice).toHaveTextContent("Scheduled for Sep 1, 2026");

    const reviewConversionButton = buttonByText(
      "Review conversion",
      orderSummary,
    );
    expect(conversionNotice.parentElement).toContainElement(
      reviewConversionButton,
    );
    click(reviewConversionButton);
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review plan conversion",
    });
    expect(within(reviewDialog).getByText("Step 3 of 3")).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Configure member packages" }),
    ).not.toBeInTheDocument();
    expect(queryButtonByText("Review conversion")).toBeUndefined();
    expect(
      within(reviewDialog).queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    expect(within(reviewDialog).getByText("Every month")).toBeInTheDocument();
    const conversionPlanRow = within(reviewDialog)
      .getByText("Team plan")
      .closest("div");
    expect(conversionPlanRow).toHaveTextContent("10 concurrent runs");
    expect(conversionPlanRow).toHaveTextContent("$160");
    expect(
      within(reviewDialog).getByText("Member packages").closest("div"),
    ).toHaveTextContent("$70");
    const conversionCreditsRow = within(reviewDialog)
      .getByText("Credits")
      .closest("div");
    expect(conversionCreditsRow).toHaveTextContent("5,555 bonus included");
    expect(conversionCreditsRow).toHaveTextContent("75,555");
    expect(
      within(reviewDialog).getByText("Monthly total").closest("div"),
    ).toHaveTextContent("$229.50/month");
    const reviewConversionNotice = within(reviewDialog).getByRole("status", {
      name: "Convert plan",
    });
    expect(reviewConversionNotice).toHaveTextContent(
      "Scheduled for Sep 1, 2026",
    );
    expect(reviewConversionNotice.parentElement).toContainElement(
      buttonByText("Confirm", reviewDialog),
    );

    click(within(reviewDialog).getByLabelText("Back"));
    const returnedPackagesDialog = await screen.findByRole("dialog", {
      name: "Configure member packages",
    });
    expect(
      within(returnedPackagesDialog).getByText("Step 2 of 3"),
    ).toBeInTheDocument();
    click(buttonByText("Review conversion", returnedPackagesDialog));
    const returnedReviewDialog = await screen.findByRole("dialog", {
      name: "Review plan conversion",
    });
    click(buttonByText("Confirm", returnedReviewDialog));
    await expect(
      screen.findByText("Switches to Team on Sep 1, 2026"),
    ).resolves.toBeVisible();
    expect(successToast).toHaveBeenCalledTimes(1);
    expect(successToast).toHaveBeenLastCalledWith(
      "Subscription change confirmed.",
    );
    expect(
      screen.queryByText(
        "Conversion scheduled for Sep 1, 2026. Your current plan and entitlements remain active until then.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Legacy")).toBeInTheDocument();

    click(buttonByText("Downgrade"));
    const unchangedChoosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    const teamPlan = within(unchangedChoosePlanDialog).getByRole("article", {
      name: "Team plan",
    });
    click(buttonByText("Manage", teamPlan));
    const unchangedPackagesDialog = await screen.findByRole("dialog", {
      name: "Configure member packages",
    });
    expect(
      within(unchangedPackagesDialog).getByText("Step 2 of 3"),
    ).toBeInTheDocument();
    expect(queryButtonByText("Current plan")).toBeUndefined();
    expect(queryButtonByText("Review conversion")).toBeUndefined();

    click(within(unchangedPackagesDialog).getByLabelText("Back"));
    const revisionChoosePlanDialog = await screen.findByRole("dialog", {
      name: "Choose a plan",
    });
    const proPlan = within(revisionChoosePlanDialog).getByRole("article", {
      name: "Pro plan",
    });
    click(buttonByText("Downgrade", proPlan));
    const revisionPackagesDialog = await screen.findByRole("dialog", {
      name: "Configure member packages",
    });
    expect(
      within(revisionPackagesDialog).getByText("Step 2 of 3"),
    ).toBeInTheDocument();
    const reviewRevisionButton = buttonByText(
      "Review conversion",
      revisionPackagesDialog,
    );
    click(reviewRevisionButton);
    const revisionDialog = await screen.findByRole("dialog", {
      name: "Review plan conversion",
    });
    expect(within(revisionDialog).getByText("Step 3 of 3")).toBeInTheDocument();
    expect(queryButtonByText("Review conversion")).toBeUndefined();
    click(buttonByText("Confirm", revisionDialog));
    await expect(
      screen.findByText("Switches to Pro on Sep 1, 2026"),
    ).resolves.toBeVisible();
  });

  it("previews and confirms a current member package change inline", async () => {
    let changeProcessing = false;
    let paymentApplied = false;
    let previewed = false;
    let confirmationRequests = 0;
    let managementRequests = 0;
    const successToast = vi.spyOn(toast, "success");
    context.mocks.data.org({
      id: "org_1",
      name: "Managed Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Managed Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      managementRequests += 1;
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: paymentApplied ? 50 : 20,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange:
              changeProcessing && !paymentApplied
                ? {
                    id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                    kind: "upgrade",
                    status: "applying",
                    targetUsagePackUsd: 50,
                    effectiveAt: "2026-03-16T00:00:00Z",
                  }
                : previewed && !paymentApplied
                  ? {
                      id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                      kind: "upgrade",
                      status: "previewed",
                      targetUsagePackUsd: 50,
                      effectiveAt: "2026-03-16T00:00:00Z",
                    }
                  : null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        previewed = true;
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 50 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 1500,
          immediateCreditGrant: {
            purchasedCredits: 15_000,
            bonusCredits: 1100,
            totalCredits: 16_100,
            expiresAt: "2026-04-01T00:00:00Z",
          },
          nextRecurringAmountCents: 5000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        confirmationRequests += 1;
        expect(body).toStrictEqual({
          changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
        });
        changeProcessing = true;
        return respond(200, {
          status: "processing",
          effectiveAt: "2026-03-16T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Member packages" }),
    ).not.toBeInTheDocument();
    click(buttonByText("Compare all plans"));
    await screen.findByRole("heading", { name: "Choose a plan" });
    const proPlan = screen.getByRole("article", { name: "Pro plan" });
    const teamPlan = screen.getByRole("article", { name: "Team plan" });
    expect(buttonByText("Manage", proPlan)).not.toBeDisabled();
    expect(proPlan).toHaveTextContent("from $20/month");
    expect(teamPlan).toHaveTextContent("from $180/month");
    expect(teamPlan).toHaveTextContent(
      "Plan $160 · member packages $20–$200 each",
    );
    click(buttonByText("Manage", proPlan));

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    const memberUsage = screen.getByRole("group", {
      name: "Member usage",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(
      screen.queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    // With nothing changed there is no comparison and no repeated summary; the
    // ledger above already carries the current state.
    expect(
      within(orderSummary).queryByText("Concurrent slots"),
    ).not.toBeInTheDocument();
    expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(packageSelect);
    await user.click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    const comparisonTrigger = subscriptionComparisonTrigger(memberUsage);
    expect(comparisonTrigger).toHaveAccessibleName(
      "Subscription comparison: $50/month",
    );
    expect(comparisonTrigger).toHaveTextContent("$50/month");
    comparisonTrigger.focus();
    expect(comparisonTrigger).toHaveFocus();
    const comparisonTooltip = await screen.findByRole("tooltip");
    expect(
      within(comparisonTooltip).getByText("Subscription comparison"),
    ).toBeInTheDocument();
    expect(
      within(comparisonTooltip).getByText(
        "Your current subscription and this selection, side by side",
      ),
    ).toBeInTheDocument();
    const comparison = within(comparisonTooltip).getByRole("table", {
      name: "Current and new subscription comparison",
    });
    expect(within(comparison).getByText("Current")).toBeInTheDocument();
    expect(within(comparison).getByText("New")).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Member packages \$20 \$50/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Purchased credits 20,000 50,000/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Bonus credits 1,234 4,321/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$20\/month \$50\/month/u,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    const locationBeforeConfirmation = window.location.href;
    click(buttonByText("Confirm", orderSummary));
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    // The review is the flow's last step, not a dialog stacked on the packages
    // it reviews, so the configuration step is gone while it is open.
    expect(
      within(confirmationDialog).getByText("Step 3 of 3"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Order summary" }),
    ).not.toBeInTheDocument();
    expect(within(confirmationDialog).getByText("Today")).toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("Every month"),
    ).toBeInTheDocument();
    const dueRow = within(confirmationDialog)
      .getByText("Due now")
      .closest("div");
    expect(dueRow).toHaveTextContent("For the rest of this billing period");
    expect(dueRow).toHaveTextContent("$15.00");
    const grantRow = within(confirmationDialog)
      .getByText("Credits added after payment")
      .closest("div");
    expect(grantRow).toHaveTextContent("Expires Apr 1, 2026");
    expect(grantRow).toHaveTextContent("+16,100");
    expect(
      within(confirmationDialog).queryByText("Next recurring total"),
    ).not.toBeInTheDocument();
    expect(
      within(confirmationDialog).queryByText("Total credits"),
    ).not.toBeInTheDocument();
    const monthlyCreditsRow = within(confirmationDialog)
      .getByText("Credits")
      .closest("div");
    expect(monthlyCreditsRow).toHaveTextContent("4,321 bonus included");
    expect(monthlyCreditsRow).toHaveTextContent("54,321");
    expect(
      within(confirmationDialog).getByText("Monthly total").closest("div"),
    ).toHaveTextContent("$50/month");
    expect(
      within(confirmationDialog).queryByText(/Renews /u),
    ).not.toBeInTheDocument();
    expect(window.location.href).toBe(locationBeforeConfirmation);
    // Stepping back discards the preview and returns to the packages.
    click(within(confirmationDialog).getByLabelText("Back"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review package change" }),
      ).not.toBeInTheDocument();
    });
    await screen.findByRole("heading", { name: "Configure member packages" });
    expect(confirmationRequests).toBe(0);
    expect(window.location.href).toBe(locationBeforeConfirmation);
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    const managementRequestsBeforePreviewReload = managementRequests;
    context.mocks.ably.trigger("billing:changed");
    await waitFor(() => {
      expect(managementRequests).toBeGreaterThan(
        managementRequestsBeforePreviewReload,
      );
    });
    expect(
      buttonByText(
        "Confirm",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).not.toBeDisabled();

    click(
      buttonByText(
        "Confirm",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    );
    const reopenedConfirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    click(buttonByText("Confirm", reopenedConfirmationDialog));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    await screen.findByText("Change is processing");
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).toHaveLength(0);
    expect(confirmationRequests).toBe(1);
    expect(successToast).toHaveBeenCalledWith("Subscription change confirmed.");
    expect(window.location.href).toBe(locationBeforeConfirmation);
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });
    const managementRequestsBeforeRealtime = managementRequests;
    paymentApplied = true;
    context.mocks.ably.trigger("billing:changed");
    await waitFor(() => {
      expect(managementRequests).toBeGreaterThan(
        managementRequestsBeforeRealtime,
      );
    });

    await expect(
      screen.findByRole("combobox", { name: "Usage for Alex Chen" }),
    ).resolves.toHaveTextContent("54,321 credits · 8% off");
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).toHaveLength(0);
  });

  it("hides a retained allocation after its member leaves the workspace", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Managed Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Managed Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 20,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: null,
          },
          {
            id: "f2264b0e-2e55-4098-a9d4-7e2d7ff017d5",
            memberId: "removed_user",
            usagePackUsd: 50,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: {
              id: "18b51e88-6804-46c8-9b2f-3b130f6ca69c",
              kind: "removal",
              status: "scheduled",
              targetUsagePackUsd: null,
              effectiveAt: "2026-04-01T00:00:00Z",
            },
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));

    const memberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(within(memberUsage).getByText("Alex Chen")).toBeInTheDocument();
    expect(within(memberUsage).queryByText("removed_user")).toBeNull();
    expect(
      within(memberUsage).queryByRole("combobox", {
        name: "Usage for removed_user",
      }),
    ).toBeNull();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);

    const packageSelect = within(memberUsage).getByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();
  });

  it("shows and restores a scheduled member package downgrade", async () => {
    let restored = false;
    const successToast = vi.spyOn(toast, "success");
    context.mocks.data.org({
      id: "org_1",
      name: "Scheduled Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Scheduled Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 100,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: restored
              ? null
              : {
                  id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                  kind: "downgrade",
                  status: "scheduled",
                  targetUsagePackUsd: 50,
                  effectiveAt: "2026-04-01T00:00:00Z",
                },
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 100 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 0,
          nextRecurringAmountCents: 10_000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        });
        restored = true;
        return respond(200, {
          status: "completed",
          effectiveAt: "2026-03-16T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    const packageSelect = screen.getByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    expect(packageSelect).toHaveTextContent("54,321 credits · 8% off");
    const downgradeNotice = screen.getByText(
      "Downgrades to $50 on Apr 1, 2026.",
    );
    expect(downgradeNotice).toBeVisible();
    expect(screen.queryByText("+4,321 bonus credits")).not.toBeInTheDocument();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(screen.queryByText("Change is processing")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    const scheduledDowngrade = within(orderSummary).getByRole("status", {
      name: "Downgrade scheduled",
    });
    expect(scheduledDowngrade).toBeVisible();
    expect(scheduledDowngrade).toHaveTextContent(
      "Lower package starts Apr 1, 2026 · Existing credits remain available until they expire",
    );
    expect(queryAllByRoleFast("button", orderSummary)).toHaveLength(0);

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    const comparisonTooltip = await hoverSubscriptionComparison();
    const comparison = within(comparisonTooltip).getByRole("table", {
      name: "Current and new subscription comparison",
    });
    expect(
      within(comparison).getByRole("row", {
        name: /Member packages \$50 \$100/u,
      }),
    ).toBeInTheDocument();
    expect(buttonByText("Restore", orderSummary)).not.toBeDisabled();

    click(buttonByText("Restore", orderSummary));
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    click(buttonByText("Confirm", confirmationDialog));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(successToast).toHaveBeenCalledWith("Subscription change confirmed.");

    await expect(
      screen.findByRole("combobox", { name: "Usage for Alex Chen" }),
    ).resolves.toHaveTextContent("109,999 credits · 9% off");
    expect(
      screen.queryByText("Downgrades to $50 on Apr 1, 2026."),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast(
        "button",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).toHaveLength(0);
  });

  it("allows replacing a scheduled member package downgrade", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Replace Scheduled Usage Pack Org",
      role: "admin",
    });
    context.mocks.data.orgMembers({
      name: "Replace Scheduled Usage Pack Org",
      role: "admin",
      members: [
        {
          userId: "user_1",
          email: "alex@example.com",
          firstName: "Alex",
          lastName: "Chen",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 200,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: {
              id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
              kind: "downgrade",
              status: "scheduled",
              targetUsagePackUsd: 50,
              effectiveAt: "2026-04-01T00:00:00Z",
            },
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 100 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
          sourceTier: "pro",
          targetTier: "pro",
          immediateAmountCents: 0,
          nextRecurringAmountCents: 10_000,
          currency: "usd",
          effectiveAt: "2026-04-01T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Manage", proPlan));
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$20 · 21,234 credits · 6% off",
      }),
    );
    expect(screen.getByText("Downgrades to $20 on Apr 1, 2026.")).toBeVisible();
    expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    expect(
      screen.getByText("Downgrades to $100 on Apr 1, 2026."),
    ).toBeVisible();
    expect(
      screen.queryByText("Downgrades to $50 on Apr 1, 2026."),
    ).not.toBeInTheDocument();
    expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();

    click(buttonByText("Confirm", orderSummary));
    await expect(
      screen.findByRole("dialog", { name: "Review package change" }),
    ).resolves.toBeInTheDocument();
  });

  it("upgrades an existing usage pack plan without buying member packages again", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Usage Pack Upgrade Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "b5235934-83df-4f16-bf41-f46890db7d40",
            memberId: "user_1",
            usagePackUsd: 20,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "team",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
          sourceTier: "pro",
          targetTier: "team",
          immediateAmountCents: 8000,
          nextRecurringAmountCents: 18_000,
          currency: "usd",
          effectiveAt: "2026-03-16T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        });
        return respond(200, {
          status: "processing",
          effectiveAt: "2026-03-16T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });
    click(buttonByText("Upgrade"));

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(
      screen.queryByRole("heading", { name: "Compare plans" }),
    ).not.toBeInTheDocument();
    // A managed subscription still has its review step ahead of it.
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    expect(packageSelect).toHaveTextContent("21,234 credits · 6% off");
    expect(packageSelect).not.toBeDisabled();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    let comparison = within(await hoverSubscriptionComparison()).getByRole(
      "table",
      {
        name: "Current and new subscription comparison",
      },
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Plan Pro · \$0 Team · \$160/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Concurrent slots 2 10/u,
      }),
    ).toBeInTheDocument();
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$20\/month \$180\/month/u,
      }),
    ).toBeInTheDocument();
    const confirmButton = buttonByText("Confirm", orderSummary);

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    comparison = within(await hoverSubscriptionComparison()).getByRole(
      "table",
      {
        name: "Current and new subscription comparison",
      },
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$20\/month \$210\/month/u,
      }),
    ).toBeInTheDocument();
    expect(confirmButton).not.toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$20 · 21,234 credits · 6% off",
      }),
    );
    comparison = within(await hoverSubscriptionComparison()).getByRole(
      "table",
      {
        name: "Current and new subscription comparison",
      },
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$20\/month \$180\/month/u,
      }),
    ).toBeInTheDocument();

    const locationBeforeConfirmation = window.location.href;
    click(confirmButton);
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(within(confirmationDialog).getByText("$80.00")).toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("Monthly total").closest("div"),
    ).toHaveTextContent("$180/month");
    expect(window.location.href).toBe(locationBeforeConfirmation);
    click(buttonByText("Confirm", confirmationDialog));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(window.location.href).toBe(locationBeforeConfirmation);
  });

  it("configures a Team to Pro downgrade on the same page", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Usage Pack Downgrade Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "team",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        allocations: [
          {
            id: "3a9138ff-bb8c-4476-95c2-64775cc50ceb",
            memberId: "user_1",
            usagePackUsd: 20,
            currentPeriodEnd: "2026-04-01T00:00:00Z",
            pendingChange: null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
          ...inAppBillingPreviewFields(),
        });
        return respond(200, {
          changeId: "667d65ac-85df-4743-b421-b9d18a3ad89b",
          sourceTier: "team",
          targetTier: "pro",
          immediateAmountCents: 0,
          nextRecurringAmountCents: 2000,
          currency: "usd",
          effectiveAt: "2026-04-01T00:00:00Z",
          prorationDate: "2026-03-16T00:00:00Z",
          expiresAt: "2026-03-16T00:15:00Z",
        });
      },
    );
    context.mocks.api(
      billingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "667d65ac-85df-4743-b421-b9d18a3ad89b",
        });
        return respond(200, {
          status: "scheduled",
          effectiveAt: "2026-04-01T00:00:00Z",
          hostedInvoiceUrl: null,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Team plan")).toBeInTheDocument();
    });
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Downgrade", proPlan));

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    const comparison = within(await hoverSubscriptionComparison()).getByRole(
      "table",
      {
        name: "Current and new subscription comparison",
      },
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$180\/month \$20\/month/u,
      }),
    ).toBeInTheDocument();
    const downgradeNotice = within(orderSummary).getByRole("status", {
      name: "Downgrade",
    });
    expect(downgradeNotice).toBeVisible();
    expect(downgradeNotice).toHaveTextContent(
      "Lower package starts Apr 1, 2026 · Existing credits remain available until they expire",
    );
    expect(
      within(orderSummary).queryByText("Scheduled for Apr 1, 2026"),
    ).not.toBeInTheDocument();
    const confirmDowngradeButton = buttonByText("Confirm", orderSummary);
    expect(downgradeNotice.parentElement).toContainElement(
      confirmDowngradeButton,
    );
    click(confirmDowngradeButton);
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(
      within(confirmationDialog).queryByText("Due now"),
    ).not.toBeInTheDocument();
    expect(
      within(confirmationDialog).queryByText("$0.00"),
    ).not.toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("Monthly total").closest("div"),
    ).toHaveTextContent("$20/month");
    click(buttonByText("Confirm", confirmationDialog));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Configure member packages" }),
      ).toBeInTheDocument();
    });
  });

  it("replaces a managed Team cancellation without previewing packages", async () => {
    let requestedTargetTier: string | null = null;
    let packagePreviewCalls = 0;
    let billingStatus: BillingStatusResponse = {
      ...activeTeamBillingStatus(),
      cancelAtPeriodEnd: true,
      canRestorePlan: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-05-01T00:00:00Z",
      },
    };
    context.mocks.data.org({
      id: "org_1",
      name: "Managed Team Cancel Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
      return respond(200, usagePackCatalogResponse());
    });
    context.mocks.api(billingUsagePackManagementContract.get, ({ respond }) => {
      return respond(200, {
        tier: "team",
        currentPeriodEnd: "2026-05-01T00:00:00Z",
        allocations: [
          {
            id: "3a9138ff-bb8c-4476-95c2-64775cc50ceb",
            memberId: "user_1",
            usagePackUsd: 20,
            currentPeriodEnd: "2026-05-01T00:00:00Z",
            pendingChange: null,
          },
        ],
      });
    });
    context.mocks.api(
      billingUsagePackManagementContract.previewSubscriptionChange,
      () => {
        packagePreviewCalls += 1;
        throw new Error("Package preview must not replace a Plan cancellation");
      },
    );
    context.mocks.api(billingDowngradeContract.create, ({ body, respond }) => {
      requestedTargetTier = body.targetTier;
      billingStatus = {
        ...billingStatus,
        cancelAtPeriodEnd: false,
        scheduledChange: {
          type: "downgrade",
          targetTier: "pro",
          effectiveDate: "2026-05-01T00:00:00Z",
        },
      };
      return respond(200, {
        success: true,
        effectiveDate: "2026-05-01T00:00:00Z",
      });
    });

    detachedSetupPage({
      context,
      path: "/?settings=billing",
      user: {
        id: "user_1",
        fullName: "Alex Chen",
        email: "alex@example.com",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
    });
    click(buttonByText("Compare all plans"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Downgrade", proPlan));

    const downgradeDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(downgradeDialog).getByText("Downgrade to Pro?"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Configure member packages" }),
    ).not.toBeInTheDocument();
    click(buttonByText("Downgrade to Pro", downgradeDialog));

    await waitFor(() => {
      expect(requestedTargetTier).toBe("pro");
    });
    expect(packagePreviewCalls).toBe(0);
  });

  it("scrolls to buy credits from the credits billing deep link", async () => {
    const scrollIntoView = installScrollIntoViewMock();
    context.mocks.data.org({
      id: "org_1",
      name: "Credit Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });

    await openBillingTab("/?settings=billing&billingView=credits");

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        behavior: "smooth",
      });
    });
  });

  it("clears an unconsumed credits deep link when settings closes", async () => {
    const scrollIntoView = installScrollIntoViewMock();
    let billingStatus: BillingStatusResponse = {
      ...activeProBillingStatus(),
      canBuyCredits: false,
    };
    context.mocks.data.org({
      id: "org_1",
      name: "Credit Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });

    await openBillingTab("/?settings=billing&billingView=credits");

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      expect(
        screen.getByText(
          "Manage the payment methods used for billing in Stripe.",
        ),
      ).toBeInTheDocument();
    });
    expect(
      within(dialog).queryByRole("heading", { name: "Buy credits" }),
    ).not.toBeInTheDocument();

    click(within(dialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
    });

    billingStatus = {
      ...activeProBillingStatus(),
      canBuyCredits: true,
    };
    const reopenedDialog = await openSettingsFromAccountMenu();
    click(buttonByText("Billing", reopenedDialog));

    const buyCreditsHeading = await within(reopenedDialog).findByRole(
      "heading",
      {
        name: "Buy credits",
      },
    );
    expect(buyCreditsHeading).toBeInTheDocument();
    await waitForAnimationFrame();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("uses plan capabilities instead of the tier for gated billing controls", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Capability Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...noActiveBillingStatus(),
        canBuyConcurrency: true,
        canBuyCredits: true,
        autoRechargeAllowed: true,
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Buy credits" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Concurrency" }),
      ).toBeInTheDocument();
    });
  });

  it("recovers from a billing load failure", async () => {
    let statusCalls = 0;
    let failNextStatusRequest = false;
    const failedStatusRequestStarted = context.mocks.deferred<void>();
    const releaseFailedStatusResponse = context.mocks.deferred<void>();

    context.mocks.data.org({
      id: "org_1",
      name: "Suspended Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, async ({ respond }) => {
      statusCalls++;
      if (failNextStatusRequest) {
        failNextStatusRequest = false;
        failedStatusRequestStarted.resolve();
        await releaseFailedStatusResponse.promise;
        return respond(500, {
          error: {
            message: "Failed to load billing status",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      return respond(200, noActiveBillingStatus());
    });
    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
      expect(statusCalls).toBeGreaterThanOrEqual(2);
    });

    failNextStatusRequest = true;
    context.mocks.ably.trigger("billing:changed");
    await failedStatusRequestStarted.promise;
    releaseFailedStatusResponse.resolve();
    await expect(
      screen.findByText("Could not load billing status."),
    ).resolves.toBeInTheDocument();

    click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
      expect(screen.getByText("No active subscription")).toBeInTheDocument();
    });
  });

  it("opens the Stripe payment method portal from an active paid plan", async () => {
    let portalRequestBody: unknown;
    context.mocks.data.org({
      id: "org_1",
      name: "Paid Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingPortalContract.create, ({ body, respond }) => {
      portalRequestBody = body;
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/test-org",
      });
    });

    await openBillingTab("/?settings=billing");

    await waitFor(() => {
      expect(screen.getByText("Payment methods")).toBeInTheDocument();
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/customer-portal/test-org",
      );
    });
    expect(portalRequestBody).not.toHaveProperty("mode");
  });

  it("opens the Stripe payment method portal without a subscription", async () => {
    let portalRequestBody: unknown;
    context.mocks.data.org({
      id: "org_1",
      name: "No Subscription Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(billingPortalContract.create, ({ body, respond }) => {
      portalRequestBody = body;
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/no-subscription",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Payment methods")).toBeInTheDocument();
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/customer-portal/no-subscription",
      );
    });
    expect(portalRequestBody).not.toHaveProperty("mode");
  });

  it("opens the Stripe payment method portal in a new tab on Command-click", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "No Subscription Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(billingPortalContract.create, ({ respond }) => {
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/no-subscription",
      });
    });
    const openedTargets = context.mocks.browser.open();

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Payment methods")).toBeInTheDocument();
    });

    fireEvent.click(buttonByText("Manage"), { metaKey: true });

    await waitFor(() => {
      expect(openedTargets.calls).toStrictEqual([
        {
          url: "https://billing.stripe.com/customer-portal/no-subscription",
          target: "_blank",
          features: null,
        },
      ]);
    });
  });

  it("shows custom tier access without legacy checkout controls", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Custom Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeCustomBillingStatus());
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Custom plan")).toBeInTheDocument();
      expect(
        screen.getByText("Custom access with 10 concurrent runs"),
      ).toBeInTheDocument();
      expect(screen.getByText("10 concurrent runs")).toBeInTheDocument();
      expect(screen.getByText("Payment methods")).toBeInTheDocument();
    });
    expect(screen.queryByText("Upgrade")).not.toBeInTheDocument();
    expect(screen.queryByText("Downgrade")).not.toBeInTheDocument();
  });

  it.each(["managed subscription", "scheduled migration"] as const)(
    "keeps usage pack plans unavailable for a custom workspace with %s",
    async (source) => {
      context.mocks.data.org({
        id: "org_1",
        name: "Custom Usage Pack Org",
        role: "admin",
      });
      context.mocks.api(billingStatusContract.get, ({ respond }) => {
        return respond(200, activeCustomBillingStatus());
      });
      context.mocks.api(billingUsagePackCatalogContract.get, ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      });
      if (source === "managed subscription") {
        context.mocks.api(
          billingUsagePackManagementContract.get,
          ({ respond }) => {
            return respond(200, {
              tier: "team",
              currentPeriodEnd: "2026-04-01T00:00:00Z",
              allocations: [],
            });
          },
        );
      } else {
        context.mocks.api(
          billingUsagePackMigrationContract.get,
          ({ respond }) => {
            return respond(200, {
              tier: "team",
              targetTier: "team",
              status: "scheduled",
              migrationId: "3ea4b7cf-d71e-45dc-8273-8bc8b9712490",
              effectiveAt: "2026-09-01T00:00:00.000Z",
              hostedInvoiceUrl: null,
              configuration: {
                tier: "team",
                memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
                recurringAmountCents: 16_000,
                currency: "usd",
              },
            });
          },
        );
      }

      await openBillingTab("/?settings=billing");

      await screen.findByText("Custom plan");
      if (source === "scheduled migration") {
        await screen.findByText("Legacy");
      }

      for (let openCount = 0; openCount < 2; openCount += 1) {
        click(buttonByText("Compare all plans"));

        const choosePlanDialog = await screen.findByRole("dialog", {
          name: "Choose a plan",
        });
        expect(
          within(choosePlanDialog).getByText("Step 1 of 3"),
        ).toBeInTheDocument();
        for (const name of ["Pro plan", "Team plan"]) {
          const plan = within(choosePlanDialog).getByRole("article", { name });
          expect(buttonByText("Unavailable", plan)).toBeDisabled();
        }

        click(within(choosePlanDialog).getByLabelText("Close"));
        await waitFor(() => {
          expect(
            screen.queryByRole("dialog", { name: "Choose a plan" }),
          ).not.toBeInTheDocument();
        });
      }
    },
  );

  it("shows only the end date for a cancelled custom plan", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Custom Cancel Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeCustomBillingStatus(),
        cancelAtPeriodEnd: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "pro-suspend",
          effectiveDate: "2026-08-09T00:00:00Z",
        },
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Custom plan")).toBeInTheDocument();
      expect(
        screen.getByText("Your custom plan will end on Aug 9, 2026."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/Custom plan has been cancelled/u),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the concurrency trigger stable while opening the change dialog", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_12345678",
            quantity: 2,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
            canReduce: true,
            canChangeInApp: true,
          },
        ],
      });
    });

    await openBillingTab();

    const changeButton = buttonByText("Change");
    click(changeButton);
    await screen.findByRole("dialog", { name: "Change concurrency" });

    expect(changeButton).toHaveTextContent("Change");
    expect(changeButton).toBeEnabled();
  });

  it("keeps concurrency increases and Team restore available when the Plan is ending", async () => {
    let previewedQuantity: number | null = null;
    context.mocks.data.org({
      id: "org_1",
      name: "Ending Team Concurrency Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        cancelAtPeriodEnd: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "pro-suspend",
          effectiveDate: "2026-06-01T00:00:00Z",
        },
        concurrencyLimit: 15,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_ending_plan",
            quantity: 5,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
            canReduce: true,
            canChangeInApp: true,
          },
        ],
      });
    });
    context.mocks.api(
      billingConcurrencySubscriptionContract.previewChange,
      ({ body, respond }) => {
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 5,
          targetQuantity: body.quantity,
          immediateAmountCents: 10_000,
          nextRecurringAmountCents: 0,
          currency: "usd",
        });
      },
    );
    await openBillingTab();

    expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
    click(buttonByText("Change"));
    const changeDialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    const quantityInput = within(changeDialog).getByRole("textbox", {
      name: "Slots",
    });
    expect(
      within(changeDialog).getByLabelText(
        "Decrease additional concurrency quantity",
      ),
    ).toBeDisabled();
    expect(
      within(changeDialog).queryByText("Cancel entire subscription"),
    ).not.toBeInTheDocument();
    click(
      within(changeDialog).getByLabelText(
        "Increase additional concurrency quantity",
      ),
    );
    expect(quantityInput).toHaveValue("6");
    click(buttonByText("Review change", changeDialog));
    await waitFor(() => {
      expect(previewedQuantity).toBe(6);
    });
    click(buttonByText("Cancel", changeDialog));

    click(buttonByText("Restore Team plan"));
    const restorePlanDialog = await screen.findByRole("dialog", {
      name: "Restore Team plan?",
    });
    expect(restorePlanDialog).toHaveTextContent(
      "This will undo the scheduled cancellation for your Team plan. It will renew on Jun 1, 2026.",
    );
    expect(restorePlanDialog).toHaveTextContent(
      "Your paid concurrency (5 slots) will remain active and continue renewing with your plan.",
    );
    click(buttonByText("Cancel", restorePlanDialog));
    expect(buttonByText("Change")).toBeEnabled();
  });

  it("shows separate concurrency and Team restore actions", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Ending Team Concurrency Restore Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        cancelAtPeriodEnd: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "pro-suspend",
          effectiveDate: "2026-07-01T00:00:00Z",
        },
        concurrencyLimit: 15,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_restore_before_plan",
            quantity: 5,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
            canReduce: true,
            canChangeInApp: true,
            scheduledQuantity: 3,
            scheduledChangeAt: "2026-06-01T00:00:00Z",
          },
        ],
      });
    });

    await openBillingTab();

    click(buttonByText("Restore concurrency"));
    const restoreConcurrencyDialog = await screen.findByRole("dialog", {
      name: "Restore concurrency subscription?",
    });
    expect(restoreConcurrencyDialog).toHaveTextContent(
      "This restores renewal for your paid concurrency (5 slots). Your plan will not change.",
    );
    click(buttonByText("Cancel", restoreConcurrencyDialog));

    click(buttonByText("Restore Team plan"));
    const restoreTeamDialog = await screen.findByRole("dialog", {
      name: "Restore Team plan?",
    });
    expect(restoreTeamDialog).toBeInTheDocument();
  });

  it("manages an active concurrency subscription through Change", async () => {
    let previewedQuantity: number | null = null;
    let confirmedQuantity: number | null = null;
    let canceledSubscriptionId: string | null = null;
    let restoredSubscriptionId: string | null = null;
    let billingStatus: BillingStatusResponse = {
      ...activeTeamBillingStatus(),
      concurrencyLimit: 12,
      concurrencySubscriptions: [
        {
          id: "sub_concurrency_12345678",
          quantity: 2,
          currentPeriodEnd: "2026-06-01T00:00:00Z",
          cancelAtPeriodEnd: false,
          canReduce: true,
          canChangeInApp: true,
        },
      ],
    };

    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      billingConcurrencySubscriptionContract.cancel,
      ({ params, respond }) => {
        canceledSubscriptionId = params.subscriptionId;
        billingStatus = {
          ...billingStatus,
          concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
            (subscription) => {
              if (subscription.id !== params.subscriptionId) {
                return subscription;
              }
              return { ...subscription, cancelAtPeriodEnd: true };
            },
          ),
        };
        return respond(200, {
          success: true,
          currentPeriodEnd: "2026-06-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.restore,
      ({ params, respond }) => {
        restoredSubscriptionId = params.subscriptionId;
        billingStatus = {
          ...billingStatus,
          concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
            (subscription) => {
              if (subscription.id !== params.subscriptionId) {
                return subscription;
              }
              return { ...subscription, cancelAtPeriodEnd: false };
            },
          ),
        };
        return respond(200, { success: true });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.previewChange,
      ({ body, respond }) => {
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 2,
          targetQuantity: body.quantity,
          immediateAmountCents: 15_000,
          nextRecurringAmountCents: body.quantity * 10_000,
          currency: "usd",
        });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.confirmChange,
      ({ body, respond }) => {
        confirmedQuantity = body.quantity;
        return respond(200, {
          status: "pending_payment",
          hostedInvoiceUrl:
            "https://invoice.stripe.test/org-concurrency-change",
        });
      },
    );

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("12 concurrent runs")).toBeInTheDocument();
      expect(
        screen.getByText("10 included with your plan"),
      ).toBeInTheDocument();
      expect(screen.getByText("2 paid add-on")).toBeInTheDocument();
      expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
    });
    expect(queryButtonByText("Buy concurrency")).toBeUndefined();

    click(buttonByText("Change"));
    const initialChangeDialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(canceledSubscriptionId).toBeNull();
    expect(
      within(initialChangeDialog).queryByRole("radio"),
    ).not.toBeInTheDocument();
    click(buttonByText("Cancel entire subscription", initialChangeDialog));
    const cancelDialog = await screen.findByRole("dialog", {
      name: "Cancel entire subscription",
    });
    expect(cancelDialog).toHaveTextContent(
      "This stops renewal at the end of the current billing period. Existing slots stay active until then.",
    );
    click(buttonByText("Cancel subscription", cancelDialog));

    await waitFor(() => {
      expect(canceledSubscriptionId).toBe("sub_concurrency_12345678");
      expect(
        screen.getByText(
          "Concurrency subscription canceled. Slots stay active until Jun 1, 2026.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
      expect(buttonByText("Restore concurrency")).toBeInTheDocument();
    });

    click(buttonByText("Restore concurrency"));
    const restoreDialog = await screen.findByRole("dialog", {
      name: "Restore concurrency subscription?",
    });
    expect(restoredSubscriptionId).toBeNull();
    expect(restoreDialog).toHaveTextContent(
      "This restores renewal for your paid concurrency (2 slots). Your plan will not change.",
    );
    click(buttonByText("Restore concurrency", restoreDialog));

    await waitFor(() => {
      expect(restoredSubscriptionId).toBe("sub_concurrency_12345678");
      expect(
        screen.getByText("Concurrency subscription restored."),
      ).toBeInTheDocument();
      expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
    });

    click(buttonByText("Change"));
    const changeDialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(within(changeDialog).queryByRole("radio")).not.toBeInTheDocument();
    const quantityInput = within(changeDialog).getByRole("textbox", {
      name: "Slots",
    });
    expect(quantityInput).toHaveValue("2");
    const increaseQuantity = within(changeDialog).getByLabelText(
      "Increase additional concurrency quantity",
    );
    click(increaseQuantity);
    click(increaseQuantity);

    await waitFor(() => {
      expect(within(changeDialog).getByText("$400/month")).toBeInTheDocument();
    });

    click(buttonByText("Review change", changeDialog));

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(previewedQuantity).toBe(4);
    expect(within(reviewDialog).getByText("Due today")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$150.00")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$400.00/month")).toBeInTheDocument();

    click(buttonByText("Pay and update", reviewDialog));

    await waitFor(() => {
      expect(confirmedQuantity).toBe(4);
      expect(window.location.href).toBe(
        "https://invoice.stripe.test/org-concurrency-change",
      );
    });
  });

  it("reviews and confirms an initial concurrency purchase", async () => {
    let requestedQuantity: number | null = null;
    let previewedQuantity: number | null = null;

    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Purchase Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencyUnitAmountCents: 4200,
        concurrencyPurchaseReviewAvailable: true,
      });
    });
    context.mocks.api(
      billingConcurrencyCheckoutContract.preview,
      ({ body, respond }) => {
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 0,
          targetQuantity: body.quantity,
          immediateAmountCents: 12_000,
          nextRecurringAmountCents: 36_000,
          currency: "usd",
        });
      },
    );
    context.mocks.api(
      billingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        requestedQuantity = body.quantity;
        return respond(200, { url: body.successUrl });
      },
    );

    await openBillingTab();

    click(buttonByText("Buy concurrency"));
    const purchaseDialog = await screen.findByRole("dialog", {
      name: "Buy concurrency",
    });
    expect(
      within(purchaseDialog).getByText("Monthly total"),
    ).toBeInTheDocument();
    const quantityInput = within(purchaseDialog).getByRole("textbox", {
      name: "Slots",
    });
    expect(quantityInput).toHaveValue("1");
    fireEvent.change(quantityInput, { target: { value: "" } });
    expect(quantityInput).toHaveValue("");
    expect(buttonByText("Review purchase", purchaseDialog)).toBeDisabled();
    fireEvent.change(quantityInput, { target: { value: "5" } });

    await waitFor(() => {
      expect(
        within(purchaseDialog).getByText("$210/month"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Review purchase", purchaseDialog));

    await screen.findByText("$120.00");
    const reviewDialog = screen.getByRole("dialog", {
      name: "Review concurrency purchase",
    });
    await waitFor(() => {
      expect(previewedQuantity).toBe(5);
      expect(within(reviewDialog).getByText("Due today")).toBeInTheDocument();
      expect(within(reviewDialog).getByText("$120.00")).toBeInTheDocument();
      expect(within(reviewDialog).getByText("5")).toBeInTheDocument();
      expect(
        within(reviewDialog).getByText("$360.00/month"),
      ).toBeInTheDocument();
    });
    click(buttonByText("Pay and add slots", reviewDialog));

    await waitFor(() => {
      expect(requestedQuantity).toBe(5);
      expect(
        screen.getByText(
          "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Review concurrency purchase" }),
      ).toBeNull();
    });
  });

  it("falls back to Checkout with an older billing API", async () => {
    let requestedQuantity: number | null = null;

    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Compatibility Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencyUnitAmountCents: undefined,
      });
    });
    context.mocks.api(
      billingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        requestedQuantity = body.quantity;
        return respond(200, {
          url: `https://checkout.stripe.com/concurrency?quantity=${body.quantity}`,
        });
      },
    );

    await openBillingTab();

    click(buttonByText("Buy concurrency"));
    const purchaseDialog = await screen.findByRole("dialog", {
      name: "Buy concurrency",
    });
    expect(within(purchaseDialog).getByText("—")).toBeInTheDocument();
    click(buttonByText("Buy concurrency", purchaseDialog));

    await waitFor(() => {
      expect(requestedQuantity).toBe(1);
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/concurrency?quantity=1",
      );
    });
  });

  it("lets an admin adjust to a lower concurrency subscription quantity", async () => {
    let previewedQuantity: number | null = null;
    let confirmedQuantity: number | null = null;
    let restoredSubscriptionId: string | null = null;
    let billingStatus: BillingStatusResponse = {
      ...activeTeamBillingStatus(),
      concurrencyLimit: 15,
      concurrencySubscriptions: [
        {
          id: "sub_concurrency_reduce",
          quantity: 5,
          currentPeriodEnd: "2026-06-01T00:00:00Z",
          cancelAtPeriodEnd: false,
          canReduce: true,
          canChangeInApp: true,
          scheduledQuantity: null,
          scheduledChangeAt: null,
        },
      ],
    };

    context.mocks.data.org({
      id: "org_1",
      name: "Concurrency Reduction Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      billingConcurrencySubscriptionContract.previewChange,
      ({ body, respond }) => {
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 5,
          targetQuantity: body.quantity,
          immediateAmountCents: 0,
          nextRecurringAmountCents: body.quantity * 10_000,
          currency: "usd",
          effectiveAt: "2026-06-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.confirmChange,
      ({ body, respond }) => {
        confirmedQuantity = body.quantity;
        billingStatus = {
          ...billingStatus,
          concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
            (subscription) => {
              return {
                ...subscription,
                scheduledQuantity: body.quantity,
                scheduledChangeAt: "2026-06-01T00:00:00Z",
              };
            },
          ),
        };
        return respond(200, {
          status: "completed",
          hostedInvoiceUrl: null,
          effectiveAt: "2026-06-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(
      billingConcurrencySubscriptionContract.restore,
      ({ params, respond }) => {
        restoredSubscriptionId = params.subscriptionId;
        billingStatus = {
          ...billingStatus,
          concurrencySubscriptions: billingStatus.concurrencySubscriptions.map(
            (subscription) => {
              return {
                ...subscription,
                scheduledQuantity: null,
                scheduledChangeAt: null,
              };
            },
          ),
        };
        return respond(200, { success: true });
      },
    );

    await openBillingTab();

    click(buttonByText("Change"));
    const dialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    const quantityInput = within(dialog).getByRole("textbox", {
      name: "Slots",
    });
    expect(quantityInput).toHaveValue("5");
    const decreaseQuantity = within(dialog).getByLabelText(
      "Decrease additional concurrency quantity",
    );
    click(decreaseQuantity);
    click(decreaseQuantity);
    expect(quantityInput).toHaveValue("3");
    expect(within(dialog).getByText("$300/month")).toBeInTheDocument();

    const locationBeforeChange = window.location.href;
    click(buttonByText("Review change", dialog));

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(previewedQuantity).toBe(3);
    expect(
      within(reviewDialog).queryByText("Due today"),
    ).not.toBeInTheDocument();
    expect(
      within(reviewDialog).getByText(
        "Your current slots stay active through this billing period. The lower quantity starts at renewal with no refund or account credit.",
      ),
    ).toBeInTheDocument();
    expect(
      within(reviewDialog).getByText("Scheduled for Jun 1, 2026"),
    ).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$300.00/month")).toBeInTheDocument();

    click(buttonByText("Schedule change", reviewDialog));

    await waitFor(() => {
      expect(confirmedQuantity).toBe(3);
      expect(window.location.href).toBe(locationBeforeChange);
      expect(
        screen.getByText("Changes to 3 slots on Jun 1, 2026"),
      ).toBeInTheDocument();
      expect(buttonByText("Restore concurrency")).toBeEnabled();
    });

    click(buttonByText("Restore concurrency"));
    const restoreDialog = await screen.findByRole("dialog", {
      name: "Restore concurrency subscription?",
    });
    expect(restoreDialog).toHaveTextContent(
      "This restores renewal for your paid concurrency (5 slots). Your plan will not change.",
    );
    click(buttonByText("Restore concurrency", restoreDialog));

    await waitFor(() => {
      expect(restoredSubscriptionId).toBe("sub_concurrency_reduce");
      expect(
        screen.queryByText("Changes to 3 slots on Jun 1, 2026"),
      ).not.toBeInTheDocument();
      expect(buttonByText("Change")).toBeEnabled();
    });
  });

  it("keeps concurrency quantity within the 1-to-1000 boundaries", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Concurrency Boundary Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencyLimit: 11,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_boundary",
            quantity: 1,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
            canReduce: true,
            canChangeInApp: true,
          },
        ],
      });
    });

    await openBillingTab();

    click(buttonByText("Change"));
    const dialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    const quantityInput = within(dialog).getByRole("textbox", {
      name: "Slots",
    });
    const decreaseQuantity = within(dialog).getByLabelText(
      "Decrease additional concurrency quantity",
    );
    expect(quantityInput).toHaveValue("1");
    expect(decreaseQuantity).toBeDisabled();
    fireEvent.change(quantityInput, { target: { value: "0" } });
    expect(quantityInput).toHaveValue("1");

    fireEvent.change(quantityInput, { target: { value: "1000" } });
    expect(quantityInput).toHaveValue("1000");
    expect(
      within(dialog).getByLabelText("Increase additional concurrency quantity"),
    ).toBeDisabled();
    expect(within(dialog).getByText("$100,000/month")).toBeInTheDocument();
    fireEvent.change(quantityInput, { target: { value: "1001" } });
    expect(quantityInput).toHaveValue("1000");
  });

  it("locks concurrency change actions while a preview is loading", async () => {
    const previewReady = createDeferredPromise<void>(context.signal);
    let previewStarted = false;

    context.mocks.data.org({
      id: "org_1",
      name: "Concurrency Loading Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencyLimit: 12,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_loading",
            quantity: 2,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
            canReduce: true,
            canChangeInApp: true,
          },
        ],
      });
    });
    context.mocks.api(
      billingConcurrencySubscriptionContract.previewChange,
      async ({ body, respond }) => {
        previewStarted = true;
        await previewReady.promise;
        return respond(200, {
          currentQuantity: 2,
          targetQuantity: body.quantity,
          immediateAmountCents: 10_000,
          nextRecurringAmountCents: body.quantity * 10_000,
          currency: "usd",
        });
      },
    );

    await openBillingTab();

    click(buttonByText("Change"));
    const dialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    const cancelSubscription = buttonByText(
      "Cancel entire subscription",
      dialog,
    );
    const cancel = buttonByText("Cancel", dialog);
    const increaseQuantity = within(dialog).getByLabelText(
      "Increase additional concurrency quantity",
    );
    click(increaseQuantity);
    const reviewChange = buttonByText("Review change", dialog);
    click(reviewChange);

    await waitFor(() => {
      expect(previewStarted).toBeTruthy();
      expect(reviewChange).toHaveTextContent("Updating...");
      expect(reviewChange).toBeDisabled();
    });
    expect(cancelSubscription).toBeDisabled();
    expect(cancel).toBeDisabled();
    expect(
      within(dialog).getByLabelText("Decrease additional concurrency quantity"),
    ).toBeDisabled();
    expect(
      within(dialog).getByLabelText("Increase additional concurrency quantity"),
    ).toBeDisabled();

    previewReady.resolve(undefined);
    await screen.findByRole("dialog", { name: "Review concurrency change" });
  });

  it("redirects to checkout when cancelling a plan requires payment confirmation", async () => {
    const locationAssign = context.mocks.browser.locationAssign();

    context.mocks.data.org({
      id: "org_1",
      name: "Payment Confirm Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingDowngradeContract.create, ({ respond }) => {
      return respond(200, {
        status: "payment_method_required",
        checkoutUrl: "https://checkout.stripe.com/confirm-cancel-subscription",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
      expect(screen.getByText("Downgrade")).toBeInTheDocument();
    });

    click(screen.getByText("Downgrade"));
    const downgradeDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    click(buttonByText("Cancel subscription", downgradeDialog));

    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([
        "https://checkout.stripe.com/confirm-cancel-subscription",
      ]);
    });
    expect(screen.queryByText("Downgrade plan")).not.toBeInTheDocument();
  });

  it("clears a failed downgrade before the dialog reopens", async () => {
    let downgradeRequests = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Downgrade Retry Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(billingDowngradeContract.create, ({ respond }) => {
      downgradeRequests += 1;
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Simulated downgrade failure",
        },
      });
    });

    await openBillingTab();
    click(screen.getByText("Downgrade"));

    const firstDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    click(buttonByText("Cancel subscription", firstDialog));
    await within(firstDialog).findByText(/Simulated downgrade failure/);

    click(buttonByText("Cancel", firstDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Downgrade plan" }),
      ).not.toBeInTheDocument();
    });
    click(screen.getByText("Downgrade"));

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(reopenedDialog).queryByText(/Simulated downgrade failure/),
    ).not.toBeInTheDocument();
    expect(downgradeRequests).toBe(1);
  });

  it("redirects for restore confirmation and shows success after realtime catches up", async () => {
    const locationAssign = context.mocks.browser.locationAssign();
    const successToast = vi.spyOn(toast, "success");
    let restored = false;
    let billingStatusRequests = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Restore Realtime Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      billingStatusRequests += 1;
      return respond(
        200,
        restored
          ? activeProBillingStatus()
          : {
              ...activeProBillingStatus(),
              cancelAtPeriodEnd: true,
              canRestorePlan: true,
              scheduledChange: {
                type: "cancel",
                targetTier: "limited-free-1",
                effectiveDate: "2026-04-01T00:00:00Z",
              },
            },
      );
    });
    context.mocks.api(billingRestoreContract.create, ({ respond }) => {
      return respond(200, {
        status: "payment_method_required",
        checkoutUrl: "https://checkout.stripe.com/confirm-restore-plan",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });

    click(screen.getByText("Restore plan"));
    const restoreDialog = await screen.findByRole("dialog", {
      name: "Restore Pro plan?",
    });
    click(buttonByText("Restore plan", restoreDialog));

    await waitFor(() => {
      expect(locationAssign.calls).toStrictEqual([
        "https://checkout.stripe.com/confirm-restore-plan",
      ]);
    });
    expect(screen.queryByText("Restore Pro plan?")).not.toBeInTheDocument();
    expect(successToast).not.toHaveBeenCalledWith(
      "Plan restored. Your subscription will renew normally.",
    );

    const requestsBeforeRealtime = billingStatusRequests;
    restored = true;
    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(billingStatusRequests).toBeGreaterThan(requestsBeforeRealtime);
      expect(successToast).toHaveBeenCalledWith(
        "Plan restored. Your subscription will renew normally.",
      );
    });
    expect(successToast).toHaveBeenCalledTimes(1);
  });

  it("clears a failed restore before the dialog reopens", async () => {
    let restoreRequests = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Restore Retry Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeProBillingStatus(),
        cancelAtPeriodEnd: true,
        canRestorePlan: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "limited-free-1",
          effectiveDate: "2026-04-01T00:00:00Z",
        },
      });
    });
    context.mocks.api(billingRestoreContract.create, ({ respond }) => {
      restoreRequests += 1;
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Simulated restore failure",
        },
      });
    });

    await openBillingTab();
    click(screen.getByText("Restore plan"));

    const firstDialog = await screen.findByRole("dialog", {
      name: "Restore Pro plan?",
    });
    click(buttonByText("Restore plan", firstDialog));
    await within(firstDialog).findByText(/Simulated restore failure/);

    click(buttonByText("Cancel", firstDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Restore Pro plan?" }),
      ).not.toBeInTheDocument();
    });
    click(screen.getByText("Restore plan"));

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Restore Pro plan?",
    });
    expect(
      within(reopenedDialog).queryByText(/Simulated restore failure/),
    ).not.toBeInTheDocument();
    expect(restoreRequests).toBe(1);
  });

  it.each([
    { caseName: "not restorable", canRestorePlan: false },
    { caseName: "omitted by an older API", canRestorePlan: undefined },
  ])(
    "does not offer restore when a scheduled change is $caseName",
    async ({ canRestorePlan }) => {
      context.mocks.data.org({
        id: "org_1",
        name: "Expiring Plan Org",
        role: "admin",
      });
      context.mocks.api(billingStatusContract.get, ({ respond }) => {
        return respond(200, {
          ...activeProBillingStatus(),
          subscriptionStatus: "atom_grant",
          cancelAtPeriodEnd: true,
          scheduledChange: {
            type: "cancel",
            targetTier: "limited-free-1",
            effectiveDate: "2026-04-01T00:00:00Z",
          },
          ...(canRestorePlan === undefined ? {} : { canRestorePlan }),
        });
      });

      await openBillingTab();

      await waitFor(() => {
        expect(
          screen.getByText(/has been cancelled and will end on Apr 1, 2026/),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText("Restore plan")).not.toBeInTheDocument();
    },
  );

  it("previews and confirms a saved-billing credit purchase in the app", async () => {
    const checkoutReady = createDeferredPromise<void>(context.signal);
    let startRequest: CreditCheckoutRequest | null = null;
    let confirmedPreviewToken: string | null = null;
    let billingStatusRequests = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Credit Preview Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      billingStatusRequests += 1;
      return respond(200, {
        ...activeProBillingStatus(),
        canBuyCredits: true,
      });
    });
    context.mocks.api(
      billingCreditCheckoutContract.create,
      async ({ body, respond }) => {
        startRequest = body;
        await checkoutReady.promise;
        return respond(200, {
          status: "preview",
          credits: 20_000,
          amountCents: 1800,
          currency: "usd",
          expiresAt: "2026-08-13T12:15:00.000Z",
          previewToken: "credit-preview-token",
        });
      },
    );
    context.mocks.api(
      billingCreditCheckoutContract.confirm,
      ({ body, respond }) => {
        confirmedPreviewToken = body.previewToken;
        return respond(200, {
          status: "completed",
          hostedInvoiceUrl: null,
        });
      },
    );

    await openBillingTab("/?settings=billing");
    const locationBeforePurchase = window.location.href;
    const quickBuyButton = buttonByText("Quick buy $20.00");
    click(quickBuyButton);

    await waitFor(() => {
      expect(buttonByText("Preparing...")).toBeDisabled();
    });
    expect(queryButtonByText("Redirecting...")).toBeUndefined();
    checkoutReady.resolve(undefined);

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review credit purchase",
    });
    expect(quickBuyButton).toHaveTextContent("Preparing...");
    expect(quickBuyButton).toBeDisabled();
    expect(
      within(reviewDialog).getByText(
        "Confirm this one-time charge with your saved payment method.",
      ),
    ).toBeInTheDocument();
    expect(within(reviewDialog).getByText("Today")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("Due now")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("Credits added")).toBeInTheDocument();
    expect(within(reviewDialog).queryByText("Every month")).toBeNull();
    expect(within(reviewDialog).getByText("$18.00")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("+20,000")).toBeInTheDocument();
    expect(startRequest).toMatchObject({
      credits: 20_000,
      supportsInAppPreview: true,
    });
    expect(window.location.href).toBe(locationBeforePurchase);

    click(buttonByText("Pay and add credits", reviewDialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review credit purchase" }),
      ).not.toBeInTheDocument();
    });
    expect(confirmedPreviewToken).toBe("credit-preview-token");
    expect(billingStatusRequests).toBeGreaterThan(1);
    expect(window.location.href).toBe(locationBeforePurchase);
  });

  it("clears a failed credit confirmation before the purchase dialog reopens", async () => {
    let previewCount = 0;
    let confirmationCount = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Credit Retry Org",
      role: "admin",
    });
    context.mocks.api(billingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeProBillingStatus(),
        canBuyCredits: true,
      });
    });
    context.mocks.api(billingCreditCheckoutContract.create, ({ respond }) => {
      previewCount += 1;
      return respond(200, {
        status: "preview",
        credits: 20_000,
        amountCents: 1800,
        currency: "usd",
        expiresAt: "2026-08-13T12:15:00.000Z",
        previewToken: `credit-preview-token-${previewCount}`,
      });
    });
    context.mocks.api(billingCreditCheckoutContract.confirm, ({ respond }) => {
      confirmationCount += 1;
      return respond(409, {
        error: {
          code: "CONFLICT",
          message: "Credit purchase preview is no longer valid",
        },
      });
    });

    await openBillingTab("/?settings=billing");
    click(buttonByText("Quick buy $20.00"));

    const firstDialog = await screen.findByRole("dialog", {
      name: "Review credit purchase",
    });
    click(buttonByText("Pay and add credits", firstDialog));
    await within(firstDialog).findByText(
      "Could not complete this credit purchase. Review your billing details and try again.",
    );

    click(buttonByText("Cancel", firstDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review credit purchase" }),
      ).not.toBeInTheDocument();
    });
    click(buttonByText("Quick buy $20.00"));

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Review credit purchase",
    });
    expect(
      within(reopenedDialog).queryByText(
        "Could not complete this credit purchase. Review your billing details and try again.",
      ),
    ).not.toBeInTheDocument();
    expect(previewCount).toBe(2);
    expect(confirmationCount).toBe(1);
  });

  it("manages credit purchases and auto-recharge settings", async () => {
    const billingStory = mockBillingStory();
    await openBillingTab("/?settings=billing");

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
      expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
    });

    click(screen.getByText("Custom"));
    await fill(screen.getByLabelText("Custom dollar amount"), "35");
    expect(screen.getByText("Quick buy $35.00")).toBeInTheDocument();

    click(screen.getByLabelText("Enable auto-recharge"));
    await fill(
      screen.getByLabelText("Credit threshold for auto-recharge"),
      "2000",
    );
    await fill(
      screen.getByLabelText("Auto-recharge credit amount in credits"),
      "10000",
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("auto-recharge-unsaved-bar"),
      ).toBeInTheDocument();
      expect(screen.getByText("$10.00")).toBeInTheDocument();
    });

    click(screen.getByTestId("save-button"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("auto-recharge-unsaved-bar"),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Enable auto-recharge")).toBeChecked();
      expect(
        screen.getByLabelText("Credit threshold for auto-recharge"),
      ).toHaveValue("2000");
      expect(
        screen.getByLabelText("Auto-recharge credit amount in credits"),
      ).toHaveValue("10000");
    });

    click(screen.getByText("Quick buy $35.00"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/checkout/credit-purchase",
      );
    });
    expect(billingStory.creditCheckoutRequest()).not.toHaveProperty(
      "previewExistingBilling",
    );
    expect(
      screen.queryByRole("dialog", { name: "Review credit purchase" }),
    ).not.toBeInTheDocument();
  });
});
