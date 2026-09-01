import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

type MarketingWindow = Window & {
  dataLayer?: IArguments[];
  gtag?: (...args: unknown[]) => void;
};

type MarketingEntrypointScript = (
  windowObject: Window,
  documentObject: Document,
) => void;

interface RequestedScript {
  readonly async: boolean;
  readonly url: string;
}

interface MarketingHarness {
  readonly marketingWindow: MarketingWindow;
  readonly requestedScripts: RequestedScript[];
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
  const requestedScripts: RequestedScript[] = [];
  vi.spyOn(document.head, "appendChild").mockImplementation(
    <T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        requestedScripts.push({ async: node.async, url: node.src });
      }
      return node;
    },
  );

  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${marketingEntrypointSource()}\n//# sourceURL=platform-marketing-entrypoint-test.js`,
  ) as MarketingEntrypointScript;
  executeEntrypointScript(window, document);

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
