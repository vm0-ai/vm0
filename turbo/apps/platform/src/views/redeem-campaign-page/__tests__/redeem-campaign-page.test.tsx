import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function usePortugueseLocale(): void {
  document.documentElement.lang = "pt-BR";
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

describe("redeem campaign page", () => {
  it("renders a ready campaign in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    const checkoutUrl = "https://checkout.stripe.com/test/session-pt-br";
    context.mocks.data.redeemResponse({ status: "ready", checkoutUrl });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await expect(
      screen.findByText("Resgatar seus créditos"),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText(
        /Complete a finalização da compra para adicionar esses créditos ao saldo de Default Org/u,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Resgatar créditos")).toHaveAttribute(
      "href",
      checkoutUrl,
    );
    expect(document.title).toBe("Resgatar seus créditos | VM0");
  });

  it("lets a user redeem a ready campaign through Stripe checkout", async () => {
    const checkoutUrl = "https://checkout.stripe.com/test/session-ready";
    context.mocks.data.redeemResponse({ status: "ready", checkoutUrl });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Claim your credits")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Complete checkout to add these credits to Default Org/),
    ).toBeInTheDocument();
    expect(screen.getByText("Redeem credits")).toHaveAttribute(
      "href",
      checkoutUrl,
    );
  });

  it("shows the processing post-redemption state", async () => {
    context.mocks.data.redeemResponse({ status: "processing" });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Payment received")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/applying your credits to Default Org/),
    ).toBeInTheDocument();
  });

  it("shows the Stripe success return state without waiting for the API", async () => {
    context.mocks.data.redeemResponse({
      status: "error",
      reason: "campaign_misconfigured",
    });

    detachedSetupPage({ context, path: "/redeem/ZERO100?stripe=success" });

    await waitFor(() => {
      expect(screen.getByText("Payment successful")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your credits are on the way to Default Org/),
    ).toBeInTheDocument();
  });

  it("shows the admin-required campaign error state", async () => {
    context.mocks.data.redeemResponse({
      status: "error",
      reason: "admin_required",
    });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Admin access required")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/redeem campaign credits for Default Org/),
    ).toBeInTheDocument();
  });

  it("shows the billing-unavailable campaign error state", async () => {
    context.mocks.data.redeemResponse({
      status: "error",
      reason: "billing_unavailable",
    });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(
        screen.getByText("Billing is temporarily unavailable"),
      ).toBeInTheDocument();
    });
  });
});
