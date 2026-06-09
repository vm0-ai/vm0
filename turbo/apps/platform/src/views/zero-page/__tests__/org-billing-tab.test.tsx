import {
  zeroBillingAutoRechargeContract,
  zeroBillingStatusContract,
  type BillingStatusResponse,
} from "@vm0/api-contracts/contracts/zero-billing";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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
  it("saves auto-recharge settings from the billing page", async () => {
    mockBillingStory();
    await openBillingTab();

    await waitFor(() => {
      expect(screen.getByText("Pro plan")).toBeInTheDocument();
      expect(screen.getByText("Automatic top-ups")).toBeInTheDocument();
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
  });
});
