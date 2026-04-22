/**
 * Interaction and state tests for billing-dialog.tsx.
 *
 * Covers AutoRechargeSection switch/input interactions and BillingDialog plan selection.
 * Entry point: setupPage({ path: "/" }) + context.store.set(setBillingDialogOpen$, true)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import {
  resetMockBilling,
  setMockBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import {
  downgradeDialogOpen$,
  setBillingDialogOpen$,
} from "../../../signals/zero-page/billing.ts";
import {
  zeroBillingAutoRechargeContract,
  zeroBillingCheckoutContract,
} from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

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

describe("chat-i-078: auto-recharge switch toggles enabled state", () => {
  it("calls PUT auto-recharge with enabled: true when switch is clicked while disabled", async () => {
    let capturedBody: unknown;
    server.use(
      mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          enabled: true,
          threshold: null,
          amount: null,
        });
      }),
    );

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
      ).toHaveAttribute("aria-checked", "false");
    });

    click(screen.getByRole("switch", { name: /auto-recharge/i }));

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ enabled: true });
    });
  });
});

describe("chat-s-084: auto-recharge toggle state reflects enabled value from server", () => {
  it("shows aria-checked=false when auto-recharge is disabled", async () => {
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
      ).toHaveAttribute("aria-checked", "false");
    });
  });

  it("shows aria-checked=true when auto-recharge is enabled", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /auto-recharge/i }),
      ).toHaveAttribute("aria-checked", "true");
    });
  });
});

describe("chat-i-079: threshold input updates form state on change", () => {
  it("calls PUT auto-recharge with new threshold when Save is clicked after changing threshold", async () => {
    let capturedBody: unknown;
    server.use(
      mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          enabled: true,
          threshold: 2000,
          amount: 10_000,
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toBeInTheDocument();
    });

    const thresholdInput = screen.getByPlaceholderText("e.g. 1000");
    await fill(thresholdInput, "2000");

    const saveBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn1).toBeDefined();
    click(saveBtn1!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ threshold: 2000 });
    });
  });
});

describe("chat-i-080: amount input updates form state on change", () => {
  it("calls PUT auto-recharge with new amount when Save is clicked after changing amount", async () => {
    let capturedBody: unknown;
    server.use(
      mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          enabled: true,
          threshold: 1000,
          amount: 20_000,
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 10000")).toBeInTheDocument();
    });

    const amountInput = screen.getByPlaceholderText("e.g. 10000");
    await fill(amountInput, "20000");

    const saveBtn2 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn2).toBeDefined();
    click(saveBtn2!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ amount: 20_000 });
    });
  });
});

describe("chat-i-081: save button saves auto-recharge settings", () => {
  it("calls PUT auto-recharge with correct values when Save is clicked", async () => {
    let capturedBody: unknown;
    server.use(
      mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          enabled: true,
          threshold: 2000,
          amount: 5000,
        });
      }),
    );

    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 2000, amount: 5000 },
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

    const saveBtn3 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn3).toBeDefined();
    click(saveBtn3!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({
        enabled: true,
        threshold: 2000,
        amount: 5000,
      });
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Save";
        }),
      ).not.toBeDisabled();
    });
  });
});

describe("chat-i-082: plan card click updates selected tier", () => {
  it("sets Team card to aria-pressed=true when clicked", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    const teamBtn1 = screen.getByLabelText("Team");
    click(teamBtn1);

    await waitFor(() => {
      expect(screen.getByLabelText("Team")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });
});

describe("chat-i-083: upgrade/downgrade button triggers plan change action", () => {
  it("calls POST checkout with tier=team when Upgrade to Team is clicked", async () => {
    let capturedCheckoutBody: unknown;
    server.use(
      mockApi(zeroBillingCheckoutContract.create, ({ body, respond }) => {
        capturedCheckoutBody = body;
        return respond(200, {
          url: "https://checkout.stripe.com/test?tier=team",
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
      expect(capturedCheckoutBody).toMatchObject({ tier: "team" });
    });
  });

  it("opens downgrade dialog when Downgrade is clicked after selecting Free", async () => {
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

    const downgradeBtn = screen.getAllByRole("button").find((el) => {
      return /^Downgrade$/i.test(el.textContent ?? "");
    });
    expect(downgradeBtn).toBeDefined();
    click(downgradeBtn!);

    await waitFor(() => {
      expect(context.store.get(downgradeDialogOpen$)).toBeTruthy();
    });
  });
});

describe("chat-i-085: form fields derive from server config via async computed", () => {
  it("displays threshold and amount from autoRechargeConfig$ async computed path", async () => {
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 3000, amount: 15_000 },
    });
    detachedSetupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    // formThreshold$ and formAmount$ async-derive from autoRechargeConfig$ when no
    // override is set. Verify that the inputs show the server-returned values.
    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toHaveValue(3000);
    });
    expect(screen.getByPlaceholderText("e.g. 10000")).toHaveValue(15_000);
  });
});

describe("chat-i-086: form overrides clear after successful save", () => {
  it("reverts inputs to server-returned values after save completes", async () => {
    // The default mock PUT handler (apiBillingHandlers) updates mockBillingStatus
    // in place, so after PUT the GET /billing/status will return the new values.
    // We register a custom PUT that returns 4000/20000 as the saved values.
    server.use(
      mockApi(zeroBillingAutoRechargeContract.update, ({ body, respond }) => {
        // Update mock so subsequent GET /billing/status returns the new values
        setMockBillingStatus({
          autoRecharge: {
            enabled: true,
            threshold: body.threshold ?? null,
            amount: body.amount ?? null,
          },
        });
        return respond(200, {
          enabled: true,
          threshold: body.threshold ?? null,
          amount: body.amount ?? null,
        });
      }),
    );

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
      expect(screen.getByPlaceholderText("e.g. 1000")).toHaveValue(1000);
    });

    // Edit threshold and amount to new values
    const thresholdInput = screen.getByPlaceholderText("e.g. 1000");
    await fill(thresholdInput, "4000");
    const amountInput = screen.getByPlaceholderText("e.g. 10000");
    await fill(amountInput, "20000");

    // Click Save
    const saveBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn).toBeDefined();
    click(saveBtn!);

    // After save completes, overrides are cleared and billingStatus reloads.
    // Inputs should revert to the server-returned values (4000 and 20000).
    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toHaveValue(4000);
    });
    expect(screen.getByPlaceholderText("e.g. 10000")).toHaveValue(20_000);
  });
});
