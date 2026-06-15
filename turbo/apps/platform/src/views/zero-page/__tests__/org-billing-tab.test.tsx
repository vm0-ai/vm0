import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingDowngradeContract,
  zeroBillingPortalContract,
  zeroBillingRestoreContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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
  };
}

function activeTeamBillingStatus(): BillingStatusResponse {
  return {
    ...activeProBillingStatus(),
    tier: "team",
    credits: 130_000,
    currentPeriodEnd: "2026-05-01T00:00:00Z",
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
  };
}

function mockBillingStory(): void {
  let billingStatus = activeProBillingStatus();

  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
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
        targetTier: "pro-suspend",
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

async function openBillingTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=billing" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Billing" }),
    ).toBeInTheDocument();
  });
}

describe("organization billing settings", () => {
  it("recovers from a billing load failure and starts an upgrade checkout", async () => {
    let statusCalls = 0;

    context.mocks.data.org({
      id: "org_1",
      slug: "suspended-org",
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
      slug: "paid-org",
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

  it("redirects to checkout when cancelling a plan requires payment confirmation", async () => {
    const locationAssign = context.mocks.browser.locationAssign();

    context.mocks.data.org({
      id: "org_1",
      slug: "payment-confirm-org",
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
      slug: "restore-confirm-org",
      name: "Restore Confirm Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        ...activeProBillingStatus(),
        cancelAtPeriodEnd: true,
        scheduledChange: {
          type: "cancel",
          targetTier: "pro-suspend",
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
      slug: "team-org",
      name: "Team Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, billingStatus);
    });
    context.mocks.api(
      zeroBillingDowngradeContract.create,
      ({ body, respond }) => {
        const targetTier = body.targetTier === "pro" ? "pro" : "pro-suspend";
        billingStatus = {
          ...billingStatus,
          cancelAtPeriodEnd: targetTier === "pro-suspend",
          scheduledChange:
            targetTier === "pro"
              ? {
                  type: "downgrade",
                  targetTier: "pro",
                  effectiveDate: "2026-05-01T00:00:00Z",
                }
              : {
                  type: "cancel",
                  targetTier: "pro-suspend",
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
        targetTier: "pro-suspend",
        effectiveDate: "2026-05-01T00:00:00Z",
      },
    };

    context.mocks.data.org({
      id: "org_1",
      slug: "team-cancel-org",
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
