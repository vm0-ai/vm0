import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  billingCheckoutContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";

import {
  detachedSetupPage,
  setupBootstrap,
} from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  confirmSubscriptionPurchase$,
  startUsagePackCheckout$,
} from "../../../signals/okou-page/billing.ts";

const context = testContext();

type WindowWithGtag = Window & {
  gtag?: (...args: unknown[]) => void;
};

function installGtagMock(): ReturnType<typeof vi.fn> {
  const windowWithGtag = window as WindowWithGtag;
  const originalGtag = windowWithGtag.gtag;
  const gtag = vi.fn<(...args: unknown[]) => void>();

  Object.defineProperty(windowWithGtag, "gtag", {
    configurable: true,
    value: gtag,
    writable: true,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalGtag !== undefined) {
        Object.defineProperty(windowWithGtag, "gtag", {
          configurable: true,
          value: originalGtag,
          writable: true,
        });
        return;
      }
      Reflect.deleteProperty(windowWithGtag, "gtag");
    },
    { once: true },
  );
  return gtag;
}

describe("billing redirect toast", () => {
  it("fires Paid After Onboarding after the checkout invoice is confirmed", async () => {
    const gtag = installGtagMock();
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

  it("fires Paid After Onboarding after a usage pack purchase is confirmed", async () => {
    const gtag = installGtagMock();
    context.mocks.api(
      billingUsagePackCheckoutContract.create,
      ({ body, respond }) => {
        if (body.previewToken) {
          return respond(200, {
            status: "completed",
            hostedInvoiceUrl: null,
            googleAdsConversion: {
              transactionId: "in_usage_pack_after_onboarding",
              valueUsd: 20,
            },
          });
        }
        return respond(200, {
          status: "preview",
          purchaseType: "usage_pack",
          tier: "pro",
          immediateAmountCents: 2000,
          nextRecurringAmountCents: 2000,
          currency: "usd",
          expiresAt: "2026-08-25T13:00:00.000Z",
          previewToken: "usage-pack-preview-token",
        });
      },
    );
    await setupBootstrap({ context, path: "/error" });
    await context.store.set(
      startUsagePackCheckout$,
      {
        tier: "pro",
        memberUsagePacks: [{ memberId: "test-user-123", usagePackUsd: 20 }],
      },
      false,
      context.signal,
    );
    await context.store.set(confirmSubscriptionPurchase$, context.signal);

    expect(gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: "AW-18407336975/ePWuCPuRrOccEI_YpslE",
      value: 40,
      currency: "USD",
      transaction_id: "in_usage_pack_after_onboarding",
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
