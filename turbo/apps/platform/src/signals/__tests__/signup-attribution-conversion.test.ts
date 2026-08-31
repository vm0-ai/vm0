import { describe, expect, it, vi } from "vitest";
import {
  acquisitionAttributionContract,
  type AdAttributionMetadata,
} from "@okouai/api-contracts/contracts/acquisition-attribution";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";

import indexHtml from "../../../index.html?raw";
import { setupBootstrap, setupPage } from "../../__tests__/page-helper.ts";
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
const ADSMARCH_SIGNUP_SEND_TO = "AW-18407336975/8mCZCLORrOccEI_YpslE";
const storedAdAttributionStorage = sessionStorageSignals(
  STORED_AD_ATTRIBUTION_KEY,
);

type WindowWithGtag = Window & {
  gtag?: (...args: unknown[]) => void;
};

type WindowWithMarketingQueue = WindowWithGtag & {
  dataLayer?: IArguments[];
};

type MarketingEntrypointScript = (
  windowObject: Window,
  documentObject: Document,
) => void;

function marketingEntrypointSource(): string {
  const source = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map((match) => {
      return match[1];
    })
    .find((script) => {
      return script?.includes('window.gtag("config", "AW-18407336975")');
    });
  if (source === undefined) {
    throw new Error("Unable to locate the marketing loader in index.html");
  }
  return source;
}

function executeMarketingEntrypoint(): WindowWithMarketingQueue {
  const marketingWindow = window as WindowWithMarketingQueue;
  const originalDataLayer = marketingWindow.dataLayer;
  const originalGtag = marketingWindow.gtag;
  context.mocks.browser.url("https://app.vm0.ai/");
  const timeout = vi.spyOn(window, "setTimeout").mockImplementation(() => {
    return 1;
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalDataLayer === undefined) {
        Reflect.deleteProperty(marketingWindow, "dataLayer");
      } else {
        marketingWindow.dataLayer = originalDataLayer;
      }
      if (originalGtag === undefined) {
        Reflect.deleteProperty(marketingWindow, "gtag");
      } else {
        marketingWindow.gtag = originalGtag;
      }
    },
    { once: true },
  );
  Reflect.deleteProperty(marketingWindow, "dataLayer");
  Reflect.deleteProperty(marketingWindow, "gtag");

  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${marketingEntrypointSource()}\n//# sourceURL=platform-marketing-entrypoint-test.js`,
  ) as MarketingEntrypointScript;
  const previousAfterFirstPaint = window.__vm0AfterFirstPaint;
  const previousBrowserSupported = window.__vm0BrowserSupported;
  window.__vm0AfterFirstPaint = (callback) => {
    callback();
  };
  window.__vm0BrowserSupported = true;
  try {
    executeEntrypointScript(window, document);
  } finally {
    if (previousAfterFirstPaint === undefined) {
      Reflect.deleteProperty(window, "__vm0AfterFirstPaint");
    } else {
      window.__vm0AfterFirstPaint = previousAfterFirstPaint;
    }
    if (previousBrowserSupported === undefined) {
      Reflect.deleteProperty(window, "__vm0BrowserSupported");
    } else {
      window.__vm0BrowserSupported = previousBrowserSupported;
    }
  }
  // The marketing entrypoint has already attempted to schedule its external
  // script load. Restore real timers before bootstrapping Clerk and routes.
  timeout.mockRestore();
  return marketingWindow;
}

async function setupSignedInBootstrap(
  options: { readonly createdAt?: Date } = {},
): Promise<void> {
  mockNow(context.signal);
  const bootstrapThreadId = "00000000-0000-4000-8000-000000000001";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });
  await setupBootstrap({
    context,
    // Public shared-thread routes skip attribution recording, which lets these
    // tests invoke recordSignupAttribution$ at the exact point under test while
    // still initializing auth through the real bootstrap lifecycle.
    path: `/share/threads/${bootstrapThreadId}`,
    user: {
      id: "test-user-123",
      fullName: "Test User",
      email: "test@example.com",
      createdAt: options.createdAt ?? nowDate(),
    },
    session: { token: "test-token" },
    org: {
      activeOrg: { id: "org_default", name: "Default Org" },
      memberships: [{ id: "org_default" }],
    },
  });
}

function installGtagMock() {
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

function setGoogleAnalyticsCookie(value: string): void {
  context.mocks.browser.cookie(`_ga=${encodeURIComponent(value)}`);
}

describe("signup attribution Google Ads conversion", () => {
  it("queues Signup conversions before external marketing scripts load", async () => {
    const marketingWindow = executeMarketingEntrypoint();
    const queuedBeforeSignup = marketingWindow.dataLayer?.map((entry) => {
      return [...entry];
    });
    expect(queuedBeforeSignup).toStrictEqual([
      ["js", expect.any(Date)],
      ["config", "AW-18144854014"],
      ["config", "AW-18407336975"],
    ]);

    await setupSignedInBootstrap();
    storePaidSignupAttribution();
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ respond }) => {
        return respond(200, { recorded: true });
      },
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    const queuedAfterSignup = marketingWindow.dataLayer?.map((entry) => {
      return [...entry];
    });
    expect(queuedAfterSignup).toContainEqual([
      "event",
      "conversion",
      expect.objectContaining({ send_to: SIGNUP_SEND_TO }),
    ]);
    expect(queuedAfterSignup).toContainEqual([
      "event",
      "conversion",
      expect.objectContaining({ send_to: ADSMARCH_SIGNUP_SEND_TO }),
    ]);
  });

  it("fires the Signup conversion after first-time signup attribution is recorded", async () => {
    const gtag = installGtagMock();
    let recordedAttribution: AdAttributionMetadata | undefined;
    let attributionRequests = 0;
    await setupSignedInBootstrap();
    storePaidSignupAttribution();
    setGoogleAnalyticsCookie("GA1.1.123456789.987654321");
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ body, respond }) => {
        attributionRequests += 1;
        recordedAttribution = body.attribution;
        return respond(200, { recorded: true });
      },
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(recordedAttribution).toStrictEqual({
      source_type: "paid",
      gclid: "click-123",
      gclid_present: "true",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "signup-campaign",
      vm0_source: "homepage",
      ga_client_id: "123456789.987654321",
    });
    expect(gtag).toHaveBeenCalledWith(
      "event",
      "conversion",
      expect.objectContaining({
        send_to: SIGNUP_SEND_TO,
        value: 1,
        currency: "USD",
      }),
    );
    expect(gtag).toHaveBeenCalledWith(
      "event",
      "conversion",
      expect.objectContaining({
        send_to: ADSMARCH_SIGNUP_SEND_TO,
        value: 1,
        currency: "USD",
        transaction_id: "test-user-123",
      }),
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(attributionRequests).toBe(1);
    expect(gtag).toHaveBeenCalledTimes(2);
  });

  it("completes route setup after a final attribution failure and allows a later retry", async () => {
    let attributionRequests = 0;
    storePaidSignupAttribution();
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ respond }) => {
        attributionRequests += 1;
        if (attributionRequests <= 2) {
          return respond(401, {
            error: {
              code: "UNAUTHORIZED",
              message: "Not authenticated",
            },
          });
        }
        return respond(200, { recorded: true });
      },
    );

    await expect(
      setupPage({
        context,
        path: "/_/skeleton",
        withoutRender: true,
      }),
    ).resolves.toBeUndefined();

    expect(attributionRequests).toBe(2);

    await context.store.set(recordSignupAttribution$, context.signal);
    await context.store.set(recordSignupAttribution$, context.signal);

    expect(attributionRequests).toBe(3);
  });

  it("records the GA4 client ID for a recent signup without stored ad attribution", async () => {
    const gtag = installGtagMock();
    let recordedAttribution: AdAttributionMetadata | undefined;
    await setupSignedInBootstrap();
    setGoogleAnalyticsCookie("GA1.1.123456789.987654321");
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ body, respond }) => {
        recordedAttribution = body.attribution;
        return respond(200, { recorded: true });
      },
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(recordedAttribution).toStrictEqual({
      ga_client_id: "123456789.987654321",
    });
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
    await setupSignedInBootstrap({
      createdAt: dateFromIso(isoFromNowMs(-31 * 60 * 1000)),
    });
    storePaidSignupAttribution();

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).not.toHaveBeenCalled();
  });

  it("ignores a malformed analytics cookie when no other attribution exists", async () => {
    const gtag = installGtagMock();
    let attributionRequests = 0;
    await setupSignedInBootstrap({
      createdAt: dateFromIso(isoFromNowMs(-31 * 60 * 1000)),
    });
    setGoogleAnalyticsCookie("not-a-ga-cookie");
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ respond }) => {
        attributionRequests += 1;
        return respond(200, { recorded: true });
      },
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(attributionRequests).toBe(0);
    expect(gtag).not.toHaveBeenCalled();
  });

  it("does not fire the Signup conversion when attribution was already recorded server-side", async () => {
    const gtag = installGtagMock();
    await setupSignedInBootstrap();
    storePaidSignupAttribution();
    context.mocks.api(
      acquisitionAttributionContract.recordSignup,
      ({ respond }) => {
        return respond(200, { recorded: false });
      },
    );

    await context.store.set(recordSignupAttribution$, context.signal);

    expect(gtag).not.toHaveBeenCalled();
  });
});
