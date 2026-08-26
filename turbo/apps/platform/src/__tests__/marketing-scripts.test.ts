import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const APP_SKELETON_VISIBLE_EVENT = "vm0:app-skeleton-visible";
const APP_FIRST_CONTENT_VISIBLE_EVENT = "vm0:app-first-content-visible";
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";
const LINKEDIN_SCRIPT_URL =
  "https://snap.licdn.com/li.lms-analytics/insight.min.js";
const MARKETING_FALLBACK_DELAY_MS = 30_000;

type LinkedInTracker = ((first: unknown, second: unknown) => void) & {
  q: [unknown, unknown][];
};

type MarketingWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
  _linkedin_data_partner_ids?: string[];
  lintrk?: LinkedInTracker;
};

type MarketingEntrypointScript = (
  windowObject: Window,
  documentObject: Document,
) => void;

interface ScheduledTimeout {
  readonly callback: () => void;
  readonly delay: number | undefined;
}

interface MarketingHarness {
  readonly fallbackDelay: number | undefined;
  readonly marketingWindow: MarketingWindow;
  readonly requestedScriptUrls: string[];
  readonly flushIdleCallbacks: () => void;
  readonly runFallback: () => void;
}

const context = testContext();

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

function executeMarketingEntrypoint(hostname: string): MarketingHarness {
  const marketingWindow = window as MarketingWindow;
  context.mocks.browser.url(`https://${hostname}/`);
  vi.stubGlobal("dataLayer", undefined);
  vi.stubGlobal("gtag", undefined);
  vi.stubGlobal("_linkedin_data_partner_ids", undefined);
  vi.stubGlobal("lintrk", undefined);

  const insertionPoint = document.createElement("script");
  document.head.appendChild(insertionPoint);
  context.signal.addEventListener("abort", () => {
    insertionPoint.remove();
  });
  const requestedScriptUrls: string[] = [];
  vi.spyOn(document.head, "appendChild").mockImplementation(
    <T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        requestedScriptUrls.push(node.src);
      }
      return node;
    },
  );
  vi.spyOn(document.head, "insertBefore").mockImplementation(
    <T extends Node>(node: T, _child: Node | null): T => {
      if (node instanceof HTMLScriptElement) {
        requestedScriptUrls.push(node.src);
      }
      return node;
    },
  );

  const scheduledTimeouts: ScheduledTimeout[] = [];
  vi.spyOn(window, "setTimeout").mockImplementation((handler, delay) => {
    if (typeof handler !== "function") {
      throw new Error("Expected a function timeout handler");
    }
    scheduledTimeouts.push({
      callback: () => {
        handler();
      },
      delay,
    });
    return scheduledTimeouts.length;
  });

  const idleCallbacks: IdleRequestCallback[] = [];
  vi.stubGlobal(
    "requestIdleCallback",
    (callback: IdleRequestCallback): number => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
  );

  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${marketingEntrypointSource()}\n//# sourceURL=platform-marketing-entrypoint-test.js`,
  ) as MarketingEntrypointScript;
  executeEntrypointScript(window, document);

  const fallback = scheduledTimeouts.find(({ delay }) => {
    return delay === MARKETING_FALLBACK_DELAY_MS;
  });

  return {
    fallbackDelay: fallback?.delay,
    flushIdleCallbacks: () => {
      for (const callback of idleCallbacks.splice(0)) {
        callback({
          didTimeout: false,
          timeRemaining: () => {
            return 50;
          },
        });
      }
    },
    marketingWindow,
    requestedScriptUrls,
    runFallback: () => {
      if (!fallback) {
        throw new Error("Marketing fallback was not scheduled");
      }
      fallback.callback();
    },
  };
}

describe("platform marketing scripts", () => {
  it("loads Google Ads and LinkedIn after first app content", () => {
    const harness = executeMarketingEntrypoint("app.vm0.ai");

    expect(
      harness.marketingWindow.dataLayer?.map((entry) => {
        return [...entry];
      }),
    ).toStrictEqual([
      ["js", expect.any(Date)],
      ["config", "AW-18144854014"],
      ["config", "AW-18407336975"],
    ]);

    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
    harness.flushIdleCallbacks();

    expect(harness.requestedScriptUrls).toStrictEqual([
      GOOGLE_TAG_SCRIPT_URL,
      LINKEDIN_SCRIPT_URL,
    ]);
    expect(harness.marketingWindow._linkedin_data_partner_ids).toStrictEqual([
      "9378804",
    ]);
    expect(typeof harness.marketingWindow.lintrk).toBe("function");
    expect(harness.marketingWindow.lintrk?.q).toStrictEqual([]);
  });

  it("waits 30 seconds before falling back when content never becomes ready", () => {
    const harness = executeMarketingEntrypoint("app.vm0.ai");

    expect(harness.fallbackDelay).toBe(MARKETING_FALLBACK_DELAY_MS);
    expect(harness.requestedScriptUrls).toStrictEqual([]);
    harness.runFallback();
    harness.flushIdleCallbacks();

    expect(harness.requestedScriptUrls).toStrictEqual([
      GOOGLE_TAG_SCRIPT_URL,
      LINKEDIN_SCRIPT_URL,
    ]);

    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
  });

  it("loads each script once across duplicate readiness and fallback signals", () => {
    const harness = executeMarketingEntrypoint("app.vm0.ai");

    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
    harness.runFallback();
    harness.flushIdleCallbacks();

    expect(harness.requestedScriptUrls).toStrictEqual([
      GOOGLE_TAG_SCRIPT_URL,
      LINKEDIN_SCRIPT_URL,
    ]);
  });

  it("does not request scripts when only the app skeleton is visible", () => {
    const harness = executeMarketingEntrypoint("app.vm0.ai");

    window.dispatchEvent(new Event(APP_SKELETON_VISIBLE_EVENT));
    harness.flushIdleCallbacks();

    expect(harness.requestedScriptUrls).toStrictEqual([]);

    window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
    harness.flushIdleCallbacks();
  });

  it.each(["localhost", "pr-29576-app.vm6.ai", "app.vm0.ai.example.com"])(
    "does not initialize or request scripts on %s",
    (hostname) => {
      const harness = executeMarketingEntrypoint(hostname);

      window.dispatchEvent(new Event(APP_SKELETON_VISIBLE_EVENT));
      window.dispatchEvent(new Event(APP_FIRST_CONTENT_VISIBLE_EVENT));
      harness.flushIdleCallbacks();

      expect(harness.fallbackDelay).toBeUndefined();
      expect(harness.marketingWindow.dataLayer).toBeUndefined();
      expect(harness.marketingWindow.gtag).toBeUndefined();
      expect(
        harness.marketingWindow._linkedin_data_partner_ids,
      ).toBeUndefined();
      expect(harness.marketingWindow.lintrk).toBeUndefined();
      expect(harness.requestedScriptUrls).toStrictEqual([]);
    },
  );
});
