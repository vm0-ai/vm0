/**
 * Interaction and state tests for billing-dialog.tsx.
 *
 * Covers AutoRechargeSection switch/input interactions and BillingDialog plan selection.
 * Entry point: setupPage({ path: "/" }) + context.store.set(setBillingDialogOpen$, true)
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  resetMockBilling,
  setMockBillingStatus,
} from "../../../mocks/handlers/api-billing.ts";
import {
  downgradeDialogOpen$,
  setBillingDialogOpen$,
} from "../../../signals/zero-page/billing.ts";
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

describe("chat-i-078: auto-recharge switch toggles enabled state", () => {
  it("calls PUT auto-recharge with enabled: true when switch is clicked while disabled", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: null,
          amount: null,
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
      autoRecharge: { enabled: false, threshold: null, amount: null },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(
        screen.getByRole("switch", { name: /auto-recharge/i }),
      ).toHaveAttribute("aria-checked", "false");
    });

    await user.click(screen.getByRole("switch", { name: /auto-recharge/i }));

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ enabled: true });
    });
  });
});

describe("chat-s-084: auto-recharge toggle state reflects enabled value from server", () => {
  it("shows aria-checked=false when auto-recharge is disabled", async () => {
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
      ).toHaveAttribute("aria-checked", "false");
    });
  });

  it("shows aria-checked=true when auto-recharge is enabled", async () => {
    mockBillingPageAPIs();
    setMockBillingStatus({
      tier: "pro",
      credits: 20_000,
      subscriptionStatus: "active",
      hasSubscription: true,
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
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
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: 2000,
          amount: 10_000,
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
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 1000")).toBeInTheDocument();
    });

    const thresholdInput = screen.getByPlaceholderText("e.g. 1000");
    await user.clear(thresholdInput);
    await user.type(thresholdInput, "2000");

    const saveBtn1 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn1).toBeDefined();
    await user.click(saveBtn1!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ threshold: 2000 });
    });
  });
});

describe("chat-i-080: amount input updates form state on change", () => {
  it("calls PUT auto-recharge with new amount when Save is clicked after changing amount", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: 1000,
          amount: 20_000,
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
      autoRecharge: { enabled: true, threshold: 1000, amount: 10_000 },
    });
    await setupPage({ context, path: "/" });
    await openBillingDialogAndWait();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. 10000")).toBeInTheDocument();
    });

    const amountInput = screen.getByPlaceholderText("e.g. 10000");
    await user.clear(amountInput);
    await user.type(amountInput, "20000");

    const saveBtn2 = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Save";
    });
    expect(saveBtn2).toBeDefined();
    await user.click(saveBtn2!);

    await waitFor(() => {
      expect(capturedBody).toMatchObject({ amount: 20_000 });
    });
  });
});

describe("chat-i-081: save button saves auto-recharge settings", () => {
  it("calls PUT auto-recharge with correct values when Save is clicked", async () => {
    let capturedBody: unknown;
    server.use(
      http.put("*/api/zero/billing/auto-recharge", async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          enabled: true,
          threshold: 2000,
          amount: 5000,
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
      autoRecharge: { enabled: true, threshold: 2000, amount: 5000 },
    });
    await setupPage({ context, path: "/" });
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
    await user.click(saveBtn3!);

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
      expect(screen.getByLabelText("Team")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    const teamBtn1 = screen.getByLabelText("Team");
    await user.click(teamBtn1);

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
      http.post("*/api/zero/billing/checkout", async ({ request }) => {
        capturedCheckoutBody = await request.json();
        return HttpResponse.json({
          url: "https://checkout.stripe.com/test?tier=team",
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
      expect(screen.getByLabelText("Team")).toBeInTheDocument();
    });

    const teamBtn2 = screen.getByLabelText("Team");
    await user.click(teamBtn2);

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
    await user.click(upgradeBtn1!);

    await waitFor(() => {
      expect(capturedCheckoutBody).toMatchObject({ tier: "team" });
    });
  });

  it("opens downgrade dialog when Downgrade is clicked after selecting Free", async () => {
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
      expect(screen.getByLabelText("Free")).toBeInTheDocument();
    });

    const freeBtn1 = screen.getByLabelText("Free");
    await user.click(freeBtn1);

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
    await user.click(downgradeBtn!);

    await waitFor(() => {
      expect(context.store.get(downgradeDialogOpen$)).toBeTruthy();
    });
  });
});
