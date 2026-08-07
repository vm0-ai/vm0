import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingDowngradeContract,
  zeroBillingPortalContract,
  zeroBillingRestoreContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { i18n } from "../../../i18n/index.ts";

const context = testContext();

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
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

function mockBillingStory(): void {
  let billingStatus = activeProBillingStatus();

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, billingStatus);
  });
  context.mocks.api(
    zeroBillingAutoRechargeContract.update,
    ({ body, respond }) => {
      billingStatus = {
        ...billingStatus,
        autoRecharge: {
          enabled: body.enabled,
          threshold: body.enabled ? (body.threshold ?? null) : null,
          amount: body.enabled ? (body.amount ?? null) : null,
        },
      };
      return respond(200, billingStatus.autoRecharge);
    },
  );
  context.mocks.api(zeroBillingCreditCheckoutContract.create, ({ respond }) => {
    return respond(200, {
      url: "https://billing.stripe.com/checkout/credit-purchase",
    });
  });
  context.mocks.api(zeroBillingDowngradeContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: true,
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
  context.mocks.api(zeroBillingRestoreContract.create, ({ respond }) => {
    billingStatus = {
      ...billingStatus,
      cancelAtPeriodEnd: false,
      scheduledChange: null,
    };
    return respond(200, { status: "restored" });
  });
}

async function openBillingTab(path = "/?settings=billing"): Promise<void> {
  detachedSetupPage({ context, path });
  await waitFor(() => {
    expect(
      screen.getByRole("dialog", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Billing" }),
    ).toBeInTheDocument();
  });
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
  it("localizes plans, credit purchases, and currency in Portuguese", async () => {
    let usagePackCatalogCalls = 0;
    context.mocks.data.org({
      id: "org_1",
      name: "Localized Org",
      role: "admin",
    });
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeProBillingStatus(),
        canBuyCredits: true,
        autoRechargeAllowed: true,
      });
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        usagePackCatalogCalls += 1;
        return respond(200, usagePackCatalogResponse());
      },
    );

    detachedSetupPage({
      context,
      path: "/?settings=billing",
    });

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
      expect(
        screen.getByRole("heading", { name: "Plano" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Plano Pro")).toBeInTheDocument();
      expect(screen.getByText("Gerenciar cobrança")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Comprar créditos" }),
      ).toBeInTheDocument();
      expect(buttonByText("Compra rápida de US$ 20,00")).toBeInTheDocument();
    });

    click(buttonByText("Comparar todos os planos"));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Comparar planos" }),
      ).toBeInTheDocument();
      expect(screen.getByText("20.000 créditos / mês")).toBeInTheDocument();
      expect(screen.getAllByText("/mês").length).toBeGreaterThan(0);
    });
    expect(usagePackCatalogCalls).toBe(0);
  });

  it("configures member usage behind the feature switch", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Usage Pack Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });
    click(buttonByText("Upgrade"));

    const choosePlanHeading = await screen.findByRole("heading", {
      name: "Choose a plan",
    });
    expect(choosePlanHeading).toBeInTheDocument();
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    const teamPlan = screen.getByRole("article", { name: "Team plan" });
    expect(within(proPlan).getByText("$20/month")).toBeInTheDocument();
    expect(
      within(proPlan).getByText("$0 plan + $20 required member package"),
    ).toBeInTheDocument();
    expect(within(teamPlan).getByText("$180/month")).toBeInTheDocument();
    expect(
      within(teamPlan).getByText("$160 plan + $20 required member package"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Member usage" }),
    ).not.toBeInTheDocument();

    click(buttonByText("Select Team", teamPlan));

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
    expect(alexUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(samUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(pendingUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(alexUsage).not.toBeDisabled();
    expect(samUsage).not.toBeDisabled();
    expect(pendingUsage).not.toBeDisabled();
    expect(
      within(memberUsage).getAllByText("+1,234 bonus credits"),
    ).toHaveLength(3);
    expect(
      within(memberUsage).getByText(
        "Each package belongs to one member and cannot be shared. When a package runs out, usage falls back to pay-as-you-go credits. You can upgrade to a new package later.",
      ),
    ).toBeInTheDocument();
    expect(within(orderSummary).getByText("Team plan")).toBeInTheDocument();
    expect(within(orderSummary).getByText("$160")).toBeInTheDocument();
    expect(
      within(orderSummary).getByText("Member packages"),
    ).toBeInTheDocument();
    expect(within(orderSummary).getByText("$60")).toBeInTheDocument();
    expect(within(orderSummary).getByText("Total credits")).toBeInTheDocument();
    expect(within(orderSummary).getByText("63,702")).toBeInTheDocument();
    expect(
      within(orderSummary).getByText("Bonus credits from discount"),
    ).toBeInTheDocument();
    expect(within(orderSummary).getByText("3,702")).toBeInTheDocument();
    expect(within(orderSummary).getByText("$220/month")).toBeInTheDocument();
    expect(buttonByText("Upgrade to Team", orderSummary)).not.toBeDisabled();

    click(alexUsage);
    expect(
      screen.queryByRole("option", { name: "Pay as you go" }),
    ).not.toBeInTheDocument();
    const alexFiftyDollarPack = screen.getByRole("option", {
      name: "$50 · 54,321 credits · 8% off",
    });
    click(alexFiftyDollarPack);
    expect(within(orderSummary).getByText("$250/month")).toBeInTheDocument();

    click(pendingUsage);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );

    expect(within(orderSummary).getByText("$330/month")).toBeInTheDocument();
    expect(within(orderSummary).getByText("185,554")).toBeInTheDocument();
    expect(within(orderSummary).getByText("15,554")).toBeInTheDocument();
    expect(
      within(memberUsage).getByText("+9,999 bonus credits"),
    ).toBeInTheDocument();
    expect(alexUsage).not.toBeDisabled();
    expect(samUsage).not.toBeDisabled();
    expect(pendingUsage).not.toBeDisabled();

    click(buttonByText("Change plan"));
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
    click(buttonByText("Select Team", returnedTeamPlan));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });

    const settingsDialog = screen.getByRole("dialog", { name: "Settings" });
    click(within(settingsDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Settings" }),
      ).not.toBeInTheDocument();
    });

    const reopenedDialog = await openSettingsFromAccountMenu("Alex Chen");
    click(buttonByText("Billing", reopenedDialog));
    await expect(
      screen.findByRole("heading", { name: "Choose a plan" }),
    ).resolves.toBeInTheDocument();

    const reopenedTeamPlan = screen.getByRole("article", {
      name: "Team plan",
    });
    click(buttonByText("Select Team", reopenedTeamPlan));

    const resetMemberUsage = await screen.findByRole("group", {
      name: "Member usage",
    });
    expect(
      within(resetMemberUsage).getByRole("combobox", {
        name: "Usage for Alex Chen",
      }),
    ).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(
      within(resetMemberUsage).getByRole("combobox", {
        name: "Usage for pending@example.com",
      }),
    ).toHaveTextContent("$20 · 21,234 credits · 6% off");
    const resetOrderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(
      within(resetOrderSummary).getByText("$220/month"),
    ).toBeInTheDocument();

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
      zeroBillingUsagePackCheckoutContract.create,
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

  it("scrolls to buy credits from the credits billing deep link", async () => {
    const scrollIntoView = installScrollIntoViewMock();
    context.mocks.data.org({
      id: "org_1",
      name: "Credit Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });

    await openBillingTab("/?settings=billing&billingView=credits");

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await waitFor(() => {
      expect(
        screen.getByText(
          "Subscription, payment method, and invoices in Stripe.",
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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

  it("recovers from a billing load failure and starts an upgrade checkout", async () => {
    let statusCalls = 0;

    context.mocks.data.org({
      id: "org_1",
      name: "Suspended Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      statusCalls++;
      if (statusCalls === 1) {
        return respond(500, {
          error: {
            message: "Failed to load billing status",
            code: "INTERNAL_SERVER_ERROR",
          },
        });
      }
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/test-upgrade?tier=${body.tier}`,
        });
      },
    );

    await openBillingTab();

    await expect(
      screen.findByText("Could not load billing status."),
    ).resolves.toBeInTheDocument();

    click(screen.getByText("Retry"));

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
      expect(screen.getByText("No active subscription")).toBeInTheDocument();
    });

    click(screen.getByText("Upgrade"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
    });

    click(screen.getByText("Upgrade to Team"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test-upgrade?tier=team",
      );
    });
  });

  it("opens the Stripe customer portal from an active paid plan", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Paid Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ respond }) => {
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/test-org",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Manage billing")).toBeInTheDocument();
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/customer-portal/test-org",
      );
    });
  });

  it("opens the Stripe customer portal for an add-on subscription", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Add-on Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...noActiveBillingStatus(),
        hasSubscription: true,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_12345678",
            quantity: 2,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
          },
        ],
      });
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ respond }) => {
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/add-on-org",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Manage billing")).toBeInTheDocument();
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/customer-portal/add-on-org",
      );
    });
  });

  it("shows custom tier access and disables Pro and Team checkout", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Custom Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeCustomBillingStatus());
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Custom plan")).toBeInTheDocument();
      expect(
        screen.getByText("Custom access with 10 concurrent runs"),
      ).toBeInTheDocument();
      expect(screen.getByText("10 concurrent runs")).toBeInTheDocument();
    });
    expect(screen.queryByText("Manage billing")).not.toBeInTheDocument();
    expect(screen.queryByText("Upgrade")).not.toBeInTheDocument();
    expect(screen.queryByText("Downgrade")).not.toBeInTheDocument();

    click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Custom workspaces cannot switch to Pro or Team checkout.",
        ),
      ).toBeInTheDocument();
    });
    const unavailableButtons = queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Unavailable";
    });
    expect(unavailableButtons).toHaveLength(2);
    for (const button of unavailableButtons) {
      expect(button).toBeDisabled();
    }
  });

  it("shows only the end date for a cancelled custom plan", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Custom Cancel Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
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

  it("shows team concurrency add-on and starts checkout for more slots", async () => {
    let requestedQuantity: number | null = null;
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
        },
      ],
    };

    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      zeroBillingConcurrencySubscriptionContract.cancel,
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
      zeroBillingConcurrencySubscriptionContract.restore,
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
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        requestedQuantity = body.quantity;
        return respond(200, {
          url: `https://checkout.stripe.com/concurrency?quantity=${body.quantity}`,
        });
      },
    );

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("12 concurrent runs")).toBeInTheDocument();
      expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
    });

    click(buttonByText("Cancel"));
    const cancelDialog = await screen.findByRole("dialog", {
      name: "Cancel concurrency subscription?",
    });
    expect(canceledSubscriptionId).toBeNull();
    click(buttonByText("Cancel subscription", cancelDialog));

    await waitFor(() => {
      expect(canceledSubscriptionId).toBe("sub_concurrency_12345678");
      expect(
        screen.getByText(
          "Concurrency subscription canceled. Slots stay active until Jun 1, 2026.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Active until Jun 1, 2026")).toBeInTheDocument();
      expect(buttonByText("Restore")).toBeInTheDocument();
    });

    click(buttonByText("Restore"));
    const restoreDialog = await screen.findByRole("dialog", {
      name: "Restore concurrency subscription?",
    });
    expect(restoredSubscriptionId).toBeNull();
    click(buttonByText("Restore subscription", restoreDialog));

    await waitFor(() => {
      expect(restoredSubscriptionId).toBe("sub_concurrency_12345678");
      expect(
        screen.getByText("Concurrency subscription restored."),
      ).toBeInTheDocument();
      expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
    });

    click(buttonByText("Buy concurrent"));

    const purchaseDialog = await screen.findByRole("dialog", {
      name: "Buy concurrency",
    });
    click(
      within(purchaseDialog).getByLabelText(
        "Increase additional concurrency quantity",
      ),
    );

    await waitFor(() => {
      expect(
        within(purchaseDialog).getByText("Buy $200/month"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Buy $200/month", purchaseDialog));

    await waitFor(() => {
      expect(requestedQuantity).toBe(2);
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/concurrency?quantity=2",
      );
    });
  });

  it("redirects to checkout when cancelling a plan requires payment confirmation", async () => {
    const locationAssign = context.mocks.browser.locationAssign();

    context.mocks.data.org({
      id: "org_1",
      name: "Payment Confirm Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(zeroBillingDowngradeContract.create, ({ respond }) => {
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

  it("redirects to checkout when restoring a cancelled plan requires payment confirmation", async () => {
    const locationAssign = context.mocks.browser.locationAssign();

    context.mocks.data.org({
      id: "org_1",
      name: "Restore Confirm Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeProBillingStatus(),
        cancelAtPeriodEnd: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "limited-free-1",
          effectiveDate: "2026-04-01T00:00:00Z",
        },
      });
    });
    context.mocks.api(zeroBillingRestoreContract.create, ({ respond }) => {
      return respond(200, {
        status: "payment_method_required",
        checkoutUrl: "https://checkout.stripe.com/confirm-restore-plan",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
      expect(
        screen.getByText(/has been cancelled and will end on Apr 1, 2026/),
      ).toBeInTheDocument();
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
  });

  it("manages plan changes, credit purchases, and auto-recharge settings", async () => {
    mockBillingStory();
    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
      expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
    });

    click(screen.getByText("Custom"));
    await fill(screen.getByLabelText("Custom dollar amount"), "35");
    expect(screen.getByText("Quick buy $35.00")).toBeInTheDocument();

    click(screen.getByText("Compare all plans"));
    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
      expect(screen.getByText("Team")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Back"));

    await waitFor(() => {
      expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
    });

    click(screen.getByText("Downgrade"));
    const downgradeCancelDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(downgradeCancelDialog).getByText(
        "Are you sure you want to cancel your Pro plan?",
      ),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", downgradeCancelDialog));

    await waitFor(() => {
      expect(screen.queryByText("Downgrade plan")).not.toBeInTheDocument();
    });

    click(screen.getByText("Downgrade"));
    const downgradeConfirmDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    click(buttonByText("Cancel subscription", downgradeConfirmDialog));

    await waitFor(() => {
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
      expect(
        screen.getByText(/has been cancelled and will end on Apr 1, 2026/),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Restore plan"));
    const restoreCancelDialog = await screen.findByRole("dialog", {
      name: "Restore Pro plan?",
    });
    expect(
      within(restoreCancelDialog).getByText(
        /undo the scheduled cancellation for your Pro plan/,
      ),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", restoreCancelDialog));

    await waitFor(() => {
      expect(screen.queryByText("Restore Pro plan?")).not.toBeInTheDocument();
    });

    click(screen.getByText("Restore plan"));
    const restoreConfirmDialog = await screen.findByRole("dialog", {
      name: "Restore Pro plan?",
    });
    click(buttonByText("Restore plan", restoreConfirmDialog));

    await waitFor(() => {
      expect(screen.getByText("Downgrade")).toBeInTheDocument();
      expect(
        screen.queryByText(/has been cancelled and will end on Apr 1, 2026/),
      ).not.toBeInTheDocument();
    });

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
  });

  it("schedules and restores a team plan downgrade from the pricing page", async () => {
    let billingStatus = activeTeamBillingStatus();

    context.mocks.data.org({
      id: "org_1",
      name: "Team Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      zeroBillingDowngradeContract.create,
      ({ body, respond }) => {
        const targetTier = body.targetTier === "pro" ? "pro" : "limited-free-1";
        billingStatus = {
          ...billingStatus,
          cancelAtPeriodEnd: targetTier === "limited-free-1",
          scheduledChange:
            targetTier === "pro"
              ? {
                  type: "downgrade",
                  targetTier: "pro",
                  effectiveDate: "2026-05-01T00:00:00Z",
                }
              : {
                  type: "cancel",
                  targetTier: "limited-free-1",
                  effectiveDate: "2026-05-01T00:00:00Z",
                },
        };
        return respond(200, {
          success: true,
          effectiveDate: "2026-05-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(zeroBillingRestoreContract.create, ({ respond }) => {
      billingStatus = {
        ...billingStatus,
        cancelAtPeriodEnd: false,
        scheduledChange: null,
      };
      return respond(200, { status: "restored" });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Team plan")).toBeInTheDocument();
      expect(screen.getByText("Renews May 1, 2026")).toBeInTheDocument();
    });

    click(screen.getByText("Downgrade"));
    const downgradeDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(downgradeDialog).getByText("Choose which plan to downgrade to."),
    ).toBeInTheDocument();
    const proOption = within(downgradeDialog)
      .getByText("Pro")
      .closest("button");
    if (!proOption) {
      throw new Error("Pro downgrade option not found");
    }
    click(proOption);
    click(buttonByText("Downgrade to Pro", downgradeDialog));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Downgrade scheduled. Your current plan stays active until May 1, 2026.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Your Team plan will downgrade to Pro on May 1, 2026.",
        ),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
      expect(
        screen.getAllByText("Downgrades to Pro on May 1, 2026").length,
      ).toBeGreaterThan(0);
    });

    click(screen.getByText("Restore plan"));
    const restoreDialog = await screen.findByRole("dialog", {
      name: "Restore Team plan?",
    });
    expect(
      within(restoreDialog).getByText(
        "This will cancel the scheduled downgrade to Pro. Your Team plan will continue renewing.",
      ),
    ).toBeInTheDocument();
    click(buttonByText("Restore plan", restoreDialog));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Plan restored. Your subscription will renew normally.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Current plan")).toBeInTheDocument();
      expect(
        screen.queryByText("Downgrades to Pro on May 1, 2026"),
      ).not.toBeInTheDocument();
    });
  });

  it("replaces a scheduled team cancellation with a downgrade to Pro", async () => {
    let capturedTargetTier: string | null = null;
    let billingStatus: BillingStatusResponse = {
      ...activeTeamBillingStatus(),
      cancelAtPeriodEnd: true,
      scheduledChange: {
        type: "cancel",
        targetTier: "limited-free-1",
        effectiveDate: "2026-05-01T00:00:00Z",
      },
    };

    context.mocks.data.org({
      id: "org_1",
      name: "Team Cancel Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      zeroBillingDowngradeContract.create,
      ({ body, respond }) => {
        capturedTargetTier = body.targetTier;
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
      },
    );

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Restore plan")).toBeInTheDocument();
      expect(
        screen.getByText(/has been cancelled and will end on May 1, 2026/),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Compare all plans"));

    await waitFor(() => {
      expect(screen.getByText("Compare plans")).toBeInTheDocument();
      expect(screen.getAllByText("Ends on May 1, 2026").length).toBeGreaterThan(
        0,
      );
    });

    click(buttonByText("Downgrade to Pro"));

    const downgradeDialog = await screen.findByRole("dialog", {
      name: "Downgrade plan",
    });
    expect(
      within(downgradeDialog).getByText("Downgrade to Pro?"),
    ).toBeInTheDocument();
    expect(
      within(downgradeDialog).getByText(
        /After that, this workspace moves to Pro/u,
      ),
    ).toBeInTheDocument();

    click(buttonByText("Downgrade to Pro", downgradeDialog));

    await waitFor(() => {
      expect(capturedTargetTier).toBe("pro");
      expect(
        screen.getByText(
          "Downgrade scheduled. Your current plan stays active until May 1, 2026.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Downgrades to Pro on May 1, 2026").length,
      ).toBeGreaterThan(0);
    });
  });
});
