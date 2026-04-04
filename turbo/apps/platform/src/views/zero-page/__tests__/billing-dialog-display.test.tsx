/**
 * Display and conditional tests for billing-dialog.tsx.
 *
 * Covers AutoRechargeSection (dialog variant) and BillingDialog display rendering.
 * Entry point: setupPage({ path: "/" }) + context.store.set(setBillingDialogOpen$, true)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  resetMockBilling,
  setMockBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { setBillingDialogOpen$ } from "../../../signals/zero-page/billing.ts";
import { setSelectedPlanTier$ } from "../../../signals/zero-page/billing-dialog-state.ts";
import { mockBillingPageAPIs } from "./billing-dialog-test-helpers.ts";

const context = testContext();

beforeEach(() => {
  resetMockBilling();
});

async function openBillingDialogAndWait() {
  context.store.set(setBillingDialogOpen$, true);
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

describe("chat-d-067: AutoRechargeSection renders threshold value", () => {
  it("displays the threshold value in the threshold input", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const input = screen.getByPlaceholderText("e.g. 1000");
      expect(input).toHaveValue(5000);
    });
  });
});

describe("chat-d-068: AutoRechargeSection renders amount value in credits", () => {
  it("displays the recharge amount in the credits input", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const amountInput = screen.getByPlaceholderText("e.g. 10000");
      expect(amountInput).toHaveValue(10_000);
    });
  });
});

describe("chat-d-069: AutoRechargeSection renders dollarAmount calculated from amount / CREDITS_PER_DOLLAR", () => {
  it("displays the dollar equivalent calculated as amount / 1000", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      // 10_000 credits / 1000 = $10.00
      expect(
        screen.getByLabelText(/dollar equivalent: \$10\.00/i),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-s-070: Loading state disables Save button during save", () => {
  it("disables the Save button while the save is in progress", async () => {
    let resolveSave!: () => void;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", () => {
        return new Promise<Response>((resolve) => {
          resolveSave = () => {
            resolve(
              HttpResponse.json({
                enabled: true,
                threshold: 5000,
                amount: 10_000,
              }),
            );
          };
        });
      }),
    );

    const user = userEvent.setup();
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    });

    resolveSave();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
  });
});

describe("chat-c-071: AutoRechargeSection fields render conditionally based on displayEnabled", () => {
  it("hides threshold and amount inputs when enabled is false", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /auto-recharge/i }),
      ).toBeInTheDocument();
    });

    expect(screen.queryByPlaceholderText("e.g. 1000")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("e.g. 10000")).not.toBeInTheDocument();
  });

  it("shows threshold and amount inputs when enabled is true", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 5000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("e.g. 10000")).toBeInTheDocument();
    });
  });
});

describe("chat-d-072-073: BillingDialog renders status.tier and credit count", () => {
  it("displays the current plan tier and locale-formatted credits in the description", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      // Check aria-current badge on the Pro plan card indicates current tier
      const currentBadge = within(dialog).getByText(/^Current$/);
      const proPlanCard = screen.getByRole("button", { name: /^Pro$/i });
      expect(proPlanCard).toContainElement(currentBadge);
      // Check 20,000 credits are shown in the dialog description (locale-formatted)
      const description = within(dialog).getByText(
        /You are on the Pro plan with 20,000 credits\./,
      );
      expect(description).toBeInTheDocument();
    });
  });
});

describe("chat-d-075: Selected plan ring highlight renders on chosen PlanCard", () => {
  it("renders aria-pressed on the selected PlanCard", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    await setupPage({ context, path: "/" });
    context.store.set(setSelectedPlanTier$, "team");
    await openBillingDialogAndWait();

    await waitFor(() => {
      const teamButton = screen.getByRole("button", { name: /^Team$/i });
      expect(teamButton).toHaveAttribute("aria-pressed", "true");
    });
  });
});

describe("chat-c-076: Button text changes based on isUpgrade/isDowngrade determination", () => {
  it("shows Upgrade to Team when team is selected and pro is current", async () => {
    const user = userEvent.setup();
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Team$/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^Team$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Upgrade to Team/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows Downgrade when free is selected and pro is current", async () => {
    const user = userEvent.setup();
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Free$/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^Free$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Downgrade$/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("chat-c-077: Action button is disabled during redirect", () => {
  it("disables the Upgrade button while checkout is in progress", async () => {
    let resolveCheckout!: () => void;
    server.use(
      http.post("*/api/zero/billing/checkout", () => {
        return new Promise<Response>((resolve) => {
          resolveCheckout = () => {
            resolve(
              HttpResponse.json({
                url: "https://checkout.stripe.com/test?tier=team",
              }),
            );
          };
        });
      }),
    );

    const user = userEvent.setup();
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^Team$/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^Team$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Upgrade to Team/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Upgrade to Team/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Redirecting/i }),
      ).toBeDisabled();
    });

    resolveCheckout();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Upgrade to Team/i }),
      ).not.toBeDisabled();
    });
  });
});
