/**
 * Display and conditional tests for billing-dialog.tsx.
 *
 * Covers AutoRechargeSection (dialog variant) and BillingDialog display rendering.
 * Entry point: setupPage({ path: "/" }) + context.store.set(setBillingDialogOpen$, true)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import {
  resetMockBilling,
  setMockBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import { setBillingDialogOpen$ } from "../../../signals/zero-page/billing.ts";
import { setSelectedPlanTier$ } from "../../../signals/zero-page/billing-dialog-state.ts";
import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
} from "@vm0/core";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const input = screen.getByPlaceholderText("e.g. 1000");
      expect(input).toHaveValue(5000);
    });
  });
});

describe("chat-d-068: AutoRechargeSection renders amount value in credits", () => {
  it("displays the recharge amount in the credits input", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const amountInput = screen.getByPlaceholderText("e.g. 10000");
      expect(amountInput).toHaveValue(10_000);
    });
  });
});

describe("chat-d-069: AutoRechargeSection renders dollarAmount calculated from amount / CREDITS_PER_DOLLAR", () => {
  it("displays the dollar equivalent calculated as amount / 1000", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
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
      mockApi(
        zeroBillingAutoRechargeContract.update,
        ({ respond, deferred }) => {
          const gate = deferred<void>();
          resolveSave = () => {
            gate.resolve();
          };
          return gate.promise.then(() => {
            return respond(200, {
              enabled: true,
              threshold: 5000,
              amount: 10_000,
            });
          });
        },
      ),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 5000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Save";
        }),
      ).toBeDefined();
    });

    const saveBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn1).toBeDefined();
    click(saveBtn1!);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Saving...";
        }),
      ).toBeDisabled();
    });

    resolveSave();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Save";
        }),
      ).not.toBeDisabled();
    });
  });
});

describe("chat-c-071: AutoRechargeSection fields render conditionally based on displayEnabled", () => {
  it("hides threshold and amount inputs when enabled is false", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });
    detachedSetupPage({ context, path: "/" });
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
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 5000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("e.g. 10000")).toBeInTheDocument();
    });
  });
});

describe("chat-d-072-073: BillingDialog renders status.tier and credit count", () => {
  it("displays the current plan tier and locale-formatted credits in the description", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      // Check aria-current badge on the Pro plan card indicates current tier
      const currentBadge = within(dialog).getByText(/^Current$/);
      const proPlanCard = screen.getByLabelText("Pro");
      expect(proPlanCard).toBeInTheDocument();
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
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    context.store.set(setSelectedPlanTier$, "team");
    await openBillingDialogAndWait();

    await waitFor(() => {
      const teamButton = screen.getByLabelText("Team");
      expect(teamButton).toHaveAttribute("aria-pressed", "true");
    });
  });
});

describe("chat-c-076: Button text changes based on isUpgrade/isDowngrade determination", () => {
  it("shows Upgrade to Team when team is selected and pro is current", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toBeInTheDocument();
    });

    const teamBtn1 = screen.getByLabelText("Team");
    click(teamBtn1);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Upgrade to Team/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
  });

  it("shows Downgrade when free is selected and pro is current", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByLabelText("Free")).toBeInTheDocument();
    });

    const freeBtn1 = screen.getByLabelText("Free");
    click(freeBtn1);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /^Downgrade$/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });
  });
});

describe("chat-c-077: Action button is disabled during redirect", () => {
  it("disables the Upgrade button while checkout is in progress", async () => {
    let resolveCheckout!: () => void;
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ respond, deferred }) => {
        const gate = deferred<void>();
        resolveCheckout = () => {
          gate.resolve();
        };
        return gate.promise.then(() => {
          return respond(200, {
            url: "https://checkout.stripe.com/test?tier=team",
          });
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toBeInTheDocument();
    });

    const teamBtn2 = screen.getByLabelText("Team");
    click(teamBtn2);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Upgrade to Team/i.test(el.textContent ?? "");
        }),
      ).toBeDefined();
    });

    const upgradeBtn1 = screen.getAllByRole("button").find((el) => {
      return /Upgrade to Team/i.test(el.textContent ?? "");
    });
    expect(upgradeBtn1).toBeDefined();
    click(upgradeBtn1!);

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Redirecting/i.test(el.textContent ?? "");
        }),
      ).toBeDisabled();
    });

    resolveCheckout();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return /Upgrade to Team/i.test(el.textContent ?? "");
        }),
      ).not.toBeDisabled();
    });
  });
});
