import { describe, expect, it, vi } from "vitest";

import { initGoogleAds } from "../lib/google-ads.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

type MarketingWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
};

interface RequestedScript {
  readonly async: boolean;
  readonly url: string;
}

interface MarketingHarness {
  readonly marketingWindow: MarketingWindow;
  readonly requestedScripts: RequestedScript[];
}

const context = testContext();

function executeMarketingEntrypoint(hostname: string): MarketingHarness {
  const marketingWindow = window as MarketingWindow;
  context.mocks.browser.url(`https://${hostname}/`);
  vi.stubGlobal("dataLayer", undefined);
  vi.stubGlobal("gtag", undefined);
  const requestedScripts: RequestedScript[] = [];
  vi.spyOn(document.head, "appendChild").mockImplementation(
    <T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        requestedScripts.push({ async: node.async, url: node.src });
      }
      return node;
    },
  );

  initGoogleAds();

  return { marketingWindow, requestedScripts };
}

describe("platform marketing scripts", () => {
  it.each(["vm0.ai", "app.vm0.ai", "okou.ai", "app.okou.ai"])(
    "initializes Google Ads immediately on %s",
    (hostname) => {
      const harness = executeMarketingEntrypoint(hostname);

      expect(
        harness.marketingWindow.dataLayer?.map((entry) => {
          return [...entry];
        }),
      ).toStrictEqual([
        ["js", expect.any(Date)],
        ["config", "AW-18144854014"],
        ["config", "AW-18407336975"],
      ]);
      expect(
        harness.marketingWindow.dataLayer?.every((entry) => {
          return Object.prototype.toString.call(entry) === "[object Arguments]";
        }),
      ).toBeTruthy();
      expect(harness.requestedScripts).toStrictEqual([
        { async: true, url: GOOGLE_TAG_SCRIPT_URL },
      ]);
    },
  );

  it.each(["localhost", "pr-29576-app.vm6.ai", "app.vm0.ai.example.com"])(
    "does not initialize or request scripts on %s",
    (hostname) => {
      const harness = executeMarketingEntrypoint(hostname);

      expect(harness.marketingWindow.dataLayer).toBeUndefined();
      expect(harness.marketingWindow.gtag).toBeUndefined();
      expect(harness.requestedScripts).toStrictEqual([]);
    },
  );
});
