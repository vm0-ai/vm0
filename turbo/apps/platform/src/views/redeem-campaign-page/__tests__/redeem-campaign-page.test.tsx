import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockRedeemResponse } from "../../../mocks/handlers/api-billing.ts";

const context = testContext();

describe("redeem campaign page", () => {
  it("renders the landing card with an <a href> that points to Stripe when ready", async () => {
    const checkoutUrl = "https://checkout.stripe.com/test/session-ready";
    setMockRedeemResponse({ status: "ready", checkoutUrl });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Claim your credits")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Complete checkout to add these credits to Default Org/),
    ).toBeInTheDocument();

    const link = screen.getByText("Redeem credits");
    expect(link).toHaveAttribute("href", checkoutUrl);
  });

  it("renders already_redeemed copy when credits are already in the account", async () => {
    setMockRedeemResponse({ status: "already_granted" });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(
        screen.getByText("You've already redeemed this offer"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(/already in Default Org's account/),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to VM0")).toBeInTheDocument();
  });

  it("renders processing copy when the webhook is still settling", async () => {
    setMockRedeemResponse({ status: "processing" });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Payment received")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/applying your credits to Default Org/),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to VM0")).toBeInTheDocument();
  });

  it("renders admin_required copy when the caller is not an org admin", async () => {
    setMockRedeemResponse({ status: "error", reason: "admin_required" });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(screen.getByText("Admin access required")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/redeem campaign credits for Default Org/),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to VM0")).toBeInTheDocument();
  });

  it("renders campaign_misconfigured copy for an unknown or broken campaign", async () => {
    setMockRedeemResponse({
      status: "error",
      reason: "campaign_misconfigured",
    });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(
        screen.getByText("This offer isn't available"),
      ).toBeInTheDocument();
    });
  });

  it("renders billing_unavailable copy when Stripe env is missing", async () => {
    setMockRedeemResponse({ status: "error", reason: "billing_unavailable" });

    detachedSetupPage({ context, path: "/redeem/ZERO100" });

    await waitFor(() => {
      expect(
        screen.getByText("Billing is temporarily unavailable"),
      ).toBeInTheDocument();
    });
  });

  it("renders the Stripe success state from ?stripe=success without calling the API", async () => {
    // If the API were hit, the mock's default ready response would win and we'd
    // see "Claim your credits" instead of the success copy.
    setMockRedeemResponse({
      status: "error",
      reason: "campaign_misconfigured",
    });

    detachedSetupPage({
      context,
      path: "/redeem/ZERO100?stripe=success",
    });

    await waitFor(() => {
      expect(screen.getByText("Payment successful")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Your credits are on the way to Default Org/),
    ).toBeInTheDocument();
  });
});
