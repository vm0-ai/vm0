import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { billingCheckoutContract } from "@okouai/api-contracts/contracts/billing";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

type WindowWithGtag = Window & {
  gtag?: (...args: unknown[]) => void;
};

describe("billing redirect toast", () => {
  it("fires Paid After Onboarding after the checkout invoice is confirmed", async () => {
    const windowWithGtag = window as WindowWithGtag;
    const originalGtag = windowWithGtag.gtag;
    const gtag = vi.fn<(...args: unknown[]) => void>();

    Object.defineProperty(windowWithGtag, "gtag", {
      configurable: true,
      value: gtag,
      writable: true,
    });
    context.signal.addEventListener("abort", () => {
      if (originalGtag !== undefined) {
        Object.defineProperty(windowWithGtag, "gtag", {
          configurable: true,
          value: originalGtag,
          writable: true,
        });
        return;
      }
      Reflect.deleteProperty(windowWithGtag, "gtag");
    });
    context.mocks.api(billingCheckoutContract.complete, ({ respond }) => {
      return respond(200, {
        completed: true,
        googleAdsConversion: {
          transactionId: "in_after_onboarding",
          valueUsd: 99,
        },
      });
    });

    detachedSetupPage({
      context,
      path: "/?billing=pro&billing_session_id=cs_test_pro",
    });

    await waitFor(() => {
      expect(new URLSearchParams(search()).has("billing")).toBeFalsy();
      expect(
        new URLSearchParams(search()).has("billing_session_id"),
      ).toBeFalsy();
    });
    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: "AW-18407336975/ePWuCPuRrOccEI_YpslE",
      value: 40,
      currency: "USD",
      transaction_id: "in_after_onboarding",
    });
  });

  it("shows concurrency purchase success after returning from Stripe", async () => {
    detachedSetupPage({ context, path: "/?concurrency=purchased" });

    await waitFor(() => {
      expect(new URLSearchParams(search()).has("concurrency")).toBeFalsy();
    });
    const successToast = await screen.findByText(
      "Concurrency added. Your new slots will become available after Stripe confirms the subscription.",
    );
    expect(successToast).toBeInTheDocument();
  });
});
