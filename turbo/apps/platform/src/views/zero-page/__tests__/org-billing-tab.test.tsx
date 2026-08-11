import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingUsagePackMigrationContract,
  zeroBillingConcurrencyCheckoutContract,
  zeroBillingConcurrencySubscriptionContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingDowngradeContract,
  zeroBillingPortalContract,
  zeroBillingRestoreContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
  type UsagePackMigrationStateResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { toast } from "@vm0/ui/components/ui/sonner";
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

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
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
    paymentMethodManagementAvailable: true,
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
    paymentMethodManagementAvailable: true,
  };
}

function previousApiBillingStatus(
  status: BillingStatusResponse,
): BillingStatusResponse {
  return {
    ...status,
    paymentMethodManagementAvailable: undefined,
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

async function openBillingTab(
  path = "/?settings=billing",
  featureSwitches?: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  detachedSetupPage({ context, path, featureSwitches });
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
      expect(screen.getByText("Métodos de pagamento")).toBeInTheDocument();
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
      expect(screen.queryByText("20.000 créditos / mês")).toBeNull();
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

    expect(
      within(proPlan).getByText(
        "More credits and concurrency for teams running AI agents every day.",
      ),
    ).toBeInTheDocument();
    expect(within(proPlan).queryByText("20,000 credits / month")).toBeNull();
    expect(
      within(proPlan).getByText("7 shared agents, unlimited private"),
    ).toBeInTheDocument();
    expect(within(proPlan).queryByText("Pay as you go after that")).toBeNull();
    expect(
      within(teamPlan).getByText(
        "Room for a team of AI employees: high credit volume and 10 agents running at once.",
      ),
    ).toBeInTheDocument();
    expect(within(teamPlan).queryByText("120,000 credits / month")).toBeNull();

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
    expect(alexUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(samUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(pendingUsage).toHaveTextContent("$20 · 21,234 credits · 6% off");
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
        "Each package belongs to one member and cannot be shared. When a package runs out, usage falls back to pay-as-you-go credits. You can upgrade to a new package later.",
      ),
    ).toBeInTheDocument();
    expect(within(orderSummary).getByText("Team plan")).toBeInTheDocument();
    expect(within(orderSummary).getByText("$160")).toBeInTheDocument();
    expect(
      within(orderSummary).getByText("Concurrent slots").parentElement,
    ).toHaveTextContent("Concurrent slots10");
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
      within(memberUsage).queryByText(
        "100,000 purchased credits + 9,999 bonus credits",
      ),
    ).not.toBeInTheDocument();
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
    click(buttonByText("Start with Team", returnedTeamPlan));
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
    click(buttonByText("Start with Team", reopenedTeamPlan));

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
      pendingInvitations: [],
      membershipRequests: [],
      createdAt: "2026-01-01T00:00:00Z",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [
            { memberId: "user_1", usagePackUsd: 20 },
            { memberId: "user_2", usagePackUsd: 50 },
          ],
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    click(buttonByText("Confirm", orderSummary));
    await expect(
      screen.findByRole("dialog", { name: "Review package change" }),
    ).resolves.toBeInTheDocument();
  });

  it("does not probe legacy migrations while usage packs are disabled", async () => {
    let migrationCalls = 0;
    context.mocks.data.org({
      id: "org_1",
      name: "Legacy Team Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackMigrationContract.get,
      ({ respond }) => {
        migrationCalls += 1;
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

    await openBillingTab();

    expect(screen.getByText("Team plan")).toBeInTheDocument();
    expect(
      screen.queryByText("Move to member packages"),
    ).not.toBeInTheDocument();
    expect(queryButtonByText("Convert plan")).toBeUndefined();
    expect(migrationCalls).toBe(0);
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackMigrationContract.get,
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
    });

    await screen.findByText("Team plan");
    click(buttonByText("Compare all plans"));

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();

    migrationReady.resolve(undefined);

    await screen.findByText("Compare plans");
    const proPlan = screen.getByRole("article", { name: "Pro plan" });
    const teamPlan = screen.getByRole("article", { name: "Team plan" });
    expect(buttonByText("Convert plan", proPlan)).toBeEnabled();
    expect(buttonByText("Convert plan", teamPlan)).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Configure member packages" }),
    ).not.toBeInTheDocument();

    click(
      buttonByText(
        "Convert plan",
        screen.getByRole("article", { name: "Pro plan" }),
      ),
    );

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(
      screen.queryByRole("heading", { name: "Choose a plan" }),
    ).not.toBeInTheDocument();
    const comparison = screen.getByRole("table", {
      name: "Current and new subscription comparison",
    });
    expect(
      within(comparison).getByRole("row", {
        name: /Plan Team Legacy Pro/u,
      }),
    ).toBeInTheDocument();
    expect(within(comparison).getByText("Monthly total")).toBeInTheDocument();

    click(screen.getByLabelText("Back"));
    await screen.findByText("Compare plans");
    click(screen.getByLabelText("Back"));
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
    await screen.findByText("Compare plans");
  });

  it("does not offer a second checkout when migration is unavailable", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Paid Pro Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
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
      zeroBillingUsagePackMigrationContract.get,
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
    });

    await screen.findByText("Pro plan");
    click(buttonByText("Compare all plans"));

    const teamPlan = await screen.findByRole("article", { name: "Team plan" });
    expect(buttonByText("Start with Team", teamPlan)).toBeDisabled();
  });

  it("previews and confirms an in-place legacy Team migration", async () => {
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
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
      zeroBillingUsagePackMigrationContract.get,
      ({ respond }) => {
        return respond(200, migrationState);
      },
    );
    context.mocks.api(
      zeroBillingUsagePackMigrationContract.preview,
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
      zeroBillingUsagePackMigrationContract.confirm,
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
      zeroBillingUsagePackMigrationContract.previewRevision,
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
      zeroBillingUsagePackMigrationContract.confirmRevision,
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
    });

    await screen.findByText("Team plan");
    click(buttonByText("Compare all plans"));
    await screen.findByText("Compare plans");
    click(
      buttonByText(
        "Convert plan",
        screen.getByRole("article", { name: "Team plan" }),
      ),
    );

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
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
    const orderComparison = within(orderSummary).getByRole("table", {
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
    expect(
      within(orderSummary).getByText("Scheduled for Sep 1, 2026"),
    ).toBeInTheDocument();

    click(buttonByText("Review conversion", orderSummary));
    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review plan conversion",
    });
    expect(
      within(reviewDialog).queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    expect(within(reviewDialog).getByText("Order summary")).toBeInTheDocument();
    expect(
      within(reviewDialog).getByText("Team plan").parentElement,
    ).toHaveTextContent("$160");
    expect(
      within(reviewDialog).getByText("Concurrent slots").parentElement,
    ).toHaveTextContent("10");
    expect(
      within(reviewDialog).getByText("Member packages").parentElement,
    ).toHaveTextContent("$70");
    expect(
      within(reviewDialog).getByText("Purchased credits").parentElement,
    ).toHaveTextContent("70,000");
    expect(
      within(reviewDialog).getByText("Bonus credits").parentElement,
    ).toHaveTextContent("5,555");
    expect(
      within(reviewDialog).getByText("Monthly total").parentElement,
    ).toHaveTextContent("$229.50/month");
    expect(
      within(reviewDialog).getByText("Scheduled for Sep 1, 2026"),
    ).toBeInTheDocument();

    click(buttonByText("Confirm", reviewDialog));
    await waitFor(() => {
      expect(buttonByText("Current plan")).toBeInTheDocument();
    });
    expect(
      screen.queryByText(
        "Conversion scheduled for Sep 1, 2026. Your current plan and entitlements remain active until then.",
      ),
    ).not.toBeInTheDocument();

    click(buttonByLabel("Back"));
    await screen.findByText("Compare plans");
    click(buttonByLabel("Back"));
    await screen.findByText("Team plan");
    expect(screen.getByText("Legacy")).toBeInTheDocument();
    expect(screen.getByText("Switches to Team on Sep 1, 2026")).toBeVisible();

    click(buttonByText("Downgrade"));
    const proPlan = await screen.findByRole("article", { name: "Pro plan" });
    click(buttonByText("Downgrade", proPlan));
    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    click(buttonByText("Review conversion"));
    const revisionDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    click(buttonByText("Confirm", revisionDialog));
    await waitFor(() => {
      expect(buttonByText("Current plan")).toBeDisabled();
    });

    click(buttonByLabel("Back"));
    await screen.findByText("Compare plans");
    click(buttonByLabel("Back"));
    await expect(
      screen.findByText("Switches to Pro on Sep 1, 2026"),
    ).resolves.toBeVisible();
  });

  it("previews and confirms a current member package change inline", async () => {
    let pendingPayment = false;
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
                pendingPayment && !paymentApplied
                  ? {
                      id: "ad3bd64c-7237-436d-a221-61b14ed719e7",
                      kind: "upgrade",
                      status: "pending_payment",
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        previewed = true;
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 50 }],
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
      zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        confirmationRequests += 1;
        expect(body).toStrictEqual({
          changeId: "ad3bd64c-7237-436d-a221-61b14ed719e7",
        });
        pendingPayment = true;
        return respond(200, {
          status: "pending_payment",
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    expect(within(proPlan).getByText("$20/month")).toBeInTheDocument();
    expect(within(teamPlan).getByText("$180/month")).toBeInTheDocument();
    expect(
      within(teamPlan).getByText("Existing member packages stay unchanged."),
    ).toBeInTheDocument();
    click(buttonByText("Manage", proPlan));

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(
      within(orderSummary).queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(orderSummary).getByText("Concurrent slots").parentElement,
    ).toHaveTextContent("Concurrent slots2");
    expect(buttonByText("Current plan", orderSummary)).toBeDisabled();
    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    const comparison = within(orderSummary).getByRole("table", {
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
    expect(within(orderSummary).getByText("$50/month")).toBeInTheDocument();
    expect(screen.queryByText("Review")).not.toBeInTheDocument();
    const locationBeforeConfirmation = window.location.href;
    click(buttonByText("Confirm", orderSummary));
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(within(confirmationDialog).getByText("Due now")).toBeInTheDocument();
    expect(within(confirmationDialog).getByText("$15.00")).toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("Credits added after payment"),
    ).toBeInTheDocument();
    const creditGrant = within(confirmationDialog).getByRole("group", {
      name: "Credits added after payment",
    });
    expect(within(creditGrant).getByText("+16,100")).toBeInTheDocument();
    expect(
      within(creditGrant).getByText("Purchased credits"),
    ).toBeInTheDocument();
    expect(within(creditGrant).getByText("+15,000")).toBeInTheDocument();
    expect(within(creditGrant).getByText("Bonus credits")).toBeInTheDocument();
    expect(within(creditGrant).getByText("+1,100")).toBeInTheDocument();
    expect(
      within(creditGrant).getByText("Expires Apr 1, 2026"),
    ).toBeInTheDocument();
    expect(
      within(confirmationDialog).queryByText("Next recurring total"),
    ).not.toBeInTheDocument();
    expect(
      within(confirmationDialog).queryByText("Total credits"),
    ).not.toBeInTheDocument();
    expect(within(confirmationDialog).getByText("50,000")).toBeInTheDocument();
    expect(within(confirmationDialog).getByText("4,321")).toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("$50/month"),
    ).toBeInTheDocument();
    expect(
      within(confirmationDialog).queryByText(/Renews /u),
    ).not.toBeInTheDocument();
    expect(window.location.href).toBe(locationBeforeConfirmation);
    click(buttonByText("Cancel", confirmationDialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Review package change" }),
      ).not.toBeInTheDocument();
    });
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
    ).resolves.toHaveTextContent("$50 · 54,321 credits · 8% off");
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    expect(buttonByText("Current plan", orderSummary)).toBeDisabled();

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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 100 }],
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
      zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    expect(packageSelect).toHaveTextContent("$50 · 54,321 credits · 8% off");
    const downgradeNotice = screen.getByText(
      "Downgrades to $50 on Apr 1, 2026.",
    );
    expect(downgradeNotice).toHaveClass("text-amber-600");
    expect(screen.queryByText("+4,321 bonus credits")).not.toBeInTheDocument();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    expect(screen.queryByText("Change is processing")).not.toBeInTheDocument();
    expect(
      within(orderSummary).queryByRole("table", {
        name: "Current and new subscription comparison",
      }),
    ).not.toBeInTheDocument();
    expect(buttonByText("Current plan", orderSummary)).toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    const comparison = within(orderSummary).getByRole("table", {
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
    ).resolves.toHaveTextContent("$100 · 109,999 credits · 9% off");
    expect(
      screen.queryByText("Downgrades to $50 on Apr 1, 2026."),
    ).not.toBeInTheDocument();
    expect(
      buttonByText(
        "Current plan",
        screen.getByRole("region", { name: "Order summary" }),
      ),
    ).toBeDisabled();
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 100 }],
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    expect(screen.getByText("Downgrades to $20 on Apr 1, 2026.")).toHaveClass(
      "text-amber-600",
    );
    expect(buttonByText("Confirm", orderSummary)).not.toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$100 · 109,999 credits · 9% off",
      }),
    );
    expect(screen.getByText("Downgrades to $100 on Apr 1, 2026.")).toHaveClass(
      "text-amber-600",
    );
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "team",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
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
      zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          changeId: "703d633a-fe5b-4ea7-a46d-d76078f6c802",
        });
        return respond(200, {
          status: "pending_payment",
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
    });
    click(buttonByText("Compare all plans"));
    const teamPlan = await screen.findByRole("article", { name: "Team plan" });
    expect(within(teamPlan).getByText("$180/month")).toBeInTheDocument();
    click(buttonByText("Upgrade", teamPlan));

    await screen.findByRole("heading", {
      name: "Configure member packages",
    });
    expect(
      screen.getByRole("list", { name: "Purchase steps" }),
    ).toHaveTextContent("Packages");
    const packageSelect = await screen.findByRole("combobox", {
      name: "Usage for Alex Chen",
    });
    expect(packageSelect).toHaveTextContent("$20 · 21,234 credits · 6% off");
    expect(packageSelect).not.toBeDisabled();
    const orderSummary = screen.getByRole("region", {
      name: "Order summary",
    });
    const comparison = within(orderSummary).getByRole("table", {
      name: "Current and new subscription comparison",
    });
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
    expect(within(orderSummary).getByText("$180/month")).toBeInTheDocument();
    const confirmButton = buttonByText("Confirm", orderSummary);

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$50 · 54,321 credits · 8% off",
      }),
    );
    expect(
      within(comparison).getByRole("row", {
        name: /Monthly total \$20\/month \$210\/month/u,
      }),
    ).toBeInTheDocument();
    expect(within(orderSummary).getByText("$210/month")).toBeInTheDocument();
    expect(confirmButton).not.toBeDisabled();

    click(packageSelect);
    click(
      await screen.findByRole("option", {
        name: "$20 · 21,234 credits · 6% off",
      }),
    );
    expect(within(orderSummary).getByText("$180/month")).toBeInTheDocument();

    const locationBeforeConfirmation = window.location.href;
    click(confirmButton);
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Review package change",
    });
    expect(within(confirmationDialog).getByText("$80.00")).toBeInTheDocument();
    expect(
      within(confirmationDialog).getByText("$180/month"),
    ).toBeInTheDocument();
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
    context.mocks.api(
      zeroBillingUsagePackCatalogContract.get,
      ({ respond }) => {
        return respond(200, usagePackCatalogResponse());
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.get,
      ({ respond }) => {
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
      },
    );
    context.mocks.api(
      zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ({ body, respond }) => {
        expect(body).toStrictEqual({
          targetTier: "pro",
          memberUsagePacks: [{ memberId: "user_1", usagePackUsd: 20 }],
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
      zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
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
      featureSwitches: { [FeatureSwitchKey.UsagePackPlans]: true },
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
    expect(within(orderSummary).getByText("$20/month")).toBeInTheDocument();
    expect(
      within(orderSummary).getByText(
        "The lower package starts at the next billing date. Existing credits remain available until they expire.",
      ),
    ).toBeInTheDocument();
    expect(
      within(orderSummary).getByText("Scheduled for Apr 1, 2026"),
    ).toBeInTheDocument();
    click(buttonByText("Confirm", orderSummary));
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
      within(confirmationDialog).getByText("$20/month"),
    ).toBeInTheDocument();
    click(buttonByText("Confirm", confirmationDialog));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Configure member packages" }),
      ).toBeInTheDocument();
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

    click(screen.getByText("Start with Team"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/test-upgrade?tier=team",
      );
    });
  });

  it("opens the Stripe customer portal from an active paid plan", async () => {
    let portalRequestBody: unknown;
    context.mocks.data.org({
      id: "org_1",
      name: "Paid Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeProBillingStatus());
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ body, respond }) => {
      portalRequestBody = body;
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/test-org",
      });
    });

    await openBillingTab("/?settings=billing", {
      [FeatureSwitchKey.PaymentMethodManagement]: false,
    });

    await waitFor(() => {
      expect(screen.getByText("Manage billing")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Subscription, payment method, and invoices in Stripe.",
        ),
      ).toBeInTheDocument();
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
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ body, respond }) => {
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
    expect(portalRequestBody).toMatchObject({ mode: "payment_methods" });
  });

  it("opens the Stripe payment method portal in a new tab on Command-click", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "No Subscription Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ respond }) => {
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

  it("uses the legacy billing portal for a subscriber on a previous API", async () => {
    let portalRequestBody: unknown;
    context.mocks.data.org({
      id: "org_1",
      name: "Previous API Paid Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, previousApiBillingStatus(activeProBillingStatus()));
    });
    context.mocks.api(zeroBillingPortalContract.create, ({ body, respond }) => {
      portalRequestBody = body;
      return respond(200, {
        url: "https://billing.stripe.com/customer-portal/previous-api",
      });
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Manage billing")).toBeInTheDocument();
    });
    expect(screen.queryByText("Payment methods")).not.toBeInTheDocument();

    click(buttonByText("Manage"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://billing.stripe.com/customer-portal/previous-api",
      );
    });
    expect(portalRequestBody).not.toHaveProperty("mode");
  });

  it("hides payment methods without a subscription on a previous API", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Previous API No Subscription Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, previousApiBillingStatus(noActiveBillingStatus()));
    });

    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });
    expect(screen.queryByText("Payment methods")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage billing")).not.toBeInTheDocument();
  });

  it("hides payment method management without a subscription when disabled", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Disabled Payment Methods Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, noActiveBillingStatus());
    });

    await openBillingTab("/?settings=billing", {
      [FeatureSwitchKey.PaymentMethodManagement]: false,
    });

    await waitFor(() => {
      expect(screen.getByText("No active plan")).toBeInTheDocument();
    });
    expect(screen.queryByText("Payment methods")).not.toBeInTheDocument();
    expect(screen.queryByText("Manage billing")).not.toBeInTheDocument();
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
      expect(screen.getByText("Payment methods")).toBeInTheDocument();
    });
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
      zeroBillingConcurrencySubscriptionContract.previewChange,
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
      zeroBillingConcurrencySubscriptionContract.confirmChange,
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
      expect(screen.getByText("Renews Jun 1, 2026")).toBeInTheDocument();
    });
    expect(queryButtonByText("Buy concurrency")).toBeUndefined();

    click(buttonByText("Change"));
    const cancelDialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(canceledSubscriptionId).toBeNull();
    click(
      within(cancelDialog).getByRole("radio", {
        name: /Cancel entire subscription/u,
      }),
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

    click(buttonByText("Change"));
    const changeDialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(
      within(changeDialog).getByRole("radio", { name: /Change slots/u }),
    ).toHaveAttribute("aria-checked", "true");
    const quantityInput = within(changeDialog).getByLabelText(
      "New total slot quantity",
    );
    expect(quantityInput).toHaveValue("2");
    await fill(quantityInput, "4");

    await waitFor(() => {
      expect(within(changeDialog).getByText("$400/month")).toBeInTheDocument();
    });

    click(buttonByText("Review change", changeDialog));

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(previewedQuantity).toBe(4);
    expect(within(reviewDialog).getByText("$150.00")).toBeInTheDocument();
    expect(within(reviewDialog).getByText("$400.00/month")).toBeInTheDocument();

    click(buttonByText("Confirm", reviewDialog));

    await waitFor(() => {
      expect(confirmedQuantity).toBe(4);
      expect(window.location.href).toBe(
        "https://invoice.stripe.test/org-concurrency-change",
      );
    });
  });

  it("starts an initial concurrency checkout before a subscription exists", async () => {
    let requestedQuantity: number | null = null;

    context.mocks.data.org({
      id: "org_1",
      name: "Team Concurrency Purchase Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, activeTeamBillingStatus());
    });
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

    click(buttonByText("Buy concurrency"));
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

  it("lets an admin enter a lower concurrency subscription quantity", async () => {
    let previewedQuantity: number | null = null;
    let confirmedQuantity: number | null = null;

    context.mocks.data.org({
      id: "org_1",
      name: "Concurrency Reduction Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
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
          },
        ],
      });
    });
    context.mocks.api(
      zeroBillingConcurrencySubscriptionContract.previewChange,
      ({ body, respond }) => {
        previewedQuantity = body.quantity;
        return respond(200, {
          currentQuantity: 5,
          targetQuantity: body.quantity,
          immediateAmountCents: 0,
          nextRecurringAmountCents: body.quantity * 10_000,
          currency: "usd",
        });
      },
    );
    context.mocks.api(
      zeroBillingConcurrencySubscriptionContract.confirmChange,
      ({ body, respond }) => {
        confirmedQuantity = body.quantity;
        return respond(200, {
          status: "processing",
          hostedInvoiceUrl: null,
        });
      },
    );

    await openBillingTab();

    click(buttonByText("Change"));
    const dialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    expect(
      within(dialog).getByRole("radio", { name: /Change slots/u }),
    ).toHaveAttribute("aria-checked", "true");
    const quantityInput = within(dialog).getByLabelText(
      "New total slot quantity",
    );
    expect(quantityInput).toHaveValue("5");
    await fill(quantityInput, "3");
    expect(within(dialog).getByText("$300/month")).toBeInTheDocument();

    const locationBeforeChange = window.location.href;
    click(buttonByText("Review change", dialog));

    const reviewDialog = await screen.findByRole("dialog", {
      name: "Review concurrency change",
    });
    expect(previewedQuantity).toBe(3);
    expect(within(reviewDialog).queryByText("Due now")).not.toBeInTheDocument();
    expect(within(reviewDialog).getByText("$300.00/month")).toBeInTheDocument();

    click(buttonByText("Confirm", reviewDialog));

    await waitFor(() => {
      expect(confirmedQuantity).toBe(3);
      expect(window.location.href).toBe(locationBeforeChange);
    });
  });

  it("keeps the Stripe fallback and full cancellation with an older billing response", async () => {
    let requestedQuantity: number | null = null;
    context.mocks.data.org({
      id: "org_1",
      name: "Concurrency Compatibility Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeTeamBillingStatus(),
        concurrencyLimit: 12,
        concurrencySubscriptions: [
          {
            id: "sub_concurrency_compatibility",
            quantity: 2,
            currentPeriodEnd: "2026-06-01T00:00:00Z",
            cancelAtPeriodEnd: false,
          },
        ],
      });
    });
    context.mocks.api(
      zeroBillingConcurrencyCheckoutContract.create,
      ({ body, respond }) => {
        requestedQuantity = body.quantity;
        return respond(200, {
          url: "https://billing.stripe.com/concurrency-change",
        });
      },
    );

    await openBillingTab();

    expect(buttonByText("Change")).toBeInTheDocument();
    click(buttonByText("Change"));
    const dialog = await screen.findByRole("dialog", {
      name: "Change concurrency",
    });
    const quantityInput = within(dialog).getByLabelText(
      "New total slot quantity",
    );
    await fill(quantityInput, "1");
    expect(buttonByText("Continue to Stripe", dialog)).toBeDisabled();
    click(
      within(dialog).getByRole("radio", {
        name: /Cancel entire subscription/u,
      }),
    );
    expect(buttonByText("Cancel subscription", dialog)).toBeEnabled();
    click(within(dialog).getByRole("radio", { name: /Change slots/u }));
    await fill(within(dialog).getByLabelText("New total slot quantity"), "3");
    click(buttonByText("Continue to Stripe", dialog));

    await waitFor(() => {
      expect(requestedQuantity).toBe(1);
      expect(window.location.href).toBe(
        "https://billing.stripe.com/concurrency-change",
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
