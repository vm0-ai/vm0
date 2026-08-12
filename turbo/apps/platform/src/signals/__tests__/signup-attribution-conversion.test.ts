import { describe, expect, it, vi } from "vitest";
import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";

import {
  clearMockedAuthOnAbort,
  mockOrganization,
  mockUser,
} from "../../__tests__/mock-auth.ts";
import {
  dateFromIso,
  isoFromNowMs,
  mockNow,
  nowDate,
} from "../../__tests__/time.ts";
import { recordSignupAttribution$ } from "../bootstrap/signup-attribution.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { testContext } from "./test-helpers.ts";

const context = testContext();
const STORED_AD_ATTRIBUTION_KEY = "vm0.adAttribution";
const SIGNUP_SEND_TO = "AW-18144854014/OlLBCNXGgqwcEP7_kcxD";
const storedAdAttributionStorage = sessionStorageSignals(
  STORED_AD_ATTRIBUTION_KEY,
);

type WindowWithGtag = Window & {
  gtag?: (...args: unknown[]) => void;
};

function mockSignedInUser(options: { readonly createdAt?: Date } = {}): void {
  mockNow();
  mockUser(
    {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
      createdAt: options.createdAt ?? nowDate(),
    },
    {
      token: "test-token",
    },
  );
  mockOrganization({
    activeOrg: { id: "org_default", name: "Default Org" },
    memberships: [{ id: "org_default" }],
  });
  clearMockedAuthOnAbort(context.signal);
}

function installGtagMock() {
  const windowWithGtag = window as WindowWithGtag;
  const originalGtag = windowWithGtag.gtag;
  const gtag = vi.fn();

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

  return gtag;
}

function storePaidSignupAttribution(): void {
  context.store.set(
    storedAdAttributionStorage.set$,
    new URLSearchParams({
      source_type: "paid",
      gclid: "click-123",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "signup-campaign",
      vm0_source: "homepage",
    }).toString(),
  );
}

describe("signup attribution Google Ads conversion", () => {
  it("fires the Signup conversion after first-time signup attribution is recorded", async () => {
    const gtag = installGtagMock();
    mockSignedInUser();
    storePaidSignupAttribution();

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).toHaveBeenCalledWith(
      "event",
      "conversion",
      expect.objectContaining({
        send_to: SIGNUP_SEND_TO,
        value: 1,
        currency: "USD",
      }),
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).toHaveBeenCalledTimes(1);
  });

  it("fires the Signup conversion for a recent signup without stored ad attribution", async () => {
    const gtag = installGtagMock();
    mockSignedInUser();

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).toHaveBeenCalledWith(
      "event",
      "conversion",
      expect.objectContaining({
        send_to: SIGNUP_SEND_TO,
        value: 1,
        currency: "USD",
      }),
    );
  });

  it("records attribution without firing the Signup conversion for older users", async () => {
    const gtag = installGtagMock();
    mockSignedInUser({ createdAt: dateFromIso(isoFromNowMs(-31 * 60 * 1000)) });
    storePaidSignupAttribution();

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire the Signup conversion when attribution was already recorded server-side", async () => {
    const gtag = installGtagMock();
    mockSignedInUser();
    storePaidSignupAttribution();
    context.mocks.api(zeroAttributionContract.recordSignup, ({ respond }) => {
      return respond(200, { recorded: false });
    });

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).not.toHaveBeenCalled();
  });
});
