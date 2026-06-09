import {
  zeroBillingAutoRechargeContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingDowngradeContract,
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
});
