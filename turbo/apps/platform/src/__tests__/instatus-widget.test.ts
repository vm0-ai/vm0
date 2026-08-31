import { describe, expect, it, vi } from "vitest";

import indexHtml from "../../index.html?raw";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

const INSTATUS_SCRIPT_URL =
  "https://api.dashboard.instatus.com/widget?host=status.vm0.ai&code=02c0ef5a&locale=en";
const INSTATUS_SCRIPT_INTEGRITY =
  "sha384-ZW3eZwADOMdlg2fdvESPD7jguK16IC/edxNFakKs81D2lkNdi3BXRmx/g331lkD3";

type EntrypointScript = (
  windowObject: Window,
  documentObject: Document,
) => void;

function getInstatusLoaderSource(): string {
  const inlineScripts = [
    ...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi),
  ]
    .map((match) => {
      return match[1];
    })
    .filter((script): script is string => {
      return script !== undefined;
    });
  const source = inlineScripts.find((script) => {
    return script.includes(INSTATUS_SCRIPT_URL);
  });

  if (source === undefined) {
    throw new Error("Unable to locate the Instatus loader in index.html");
  }
  return source;
}

function loadInstatusScripts(
  hostname: string,
  browserSupported = true,
): HTMLScriptElement[] {
  context.mocks.browser.url(`https://${hostname}/`);
  const appendedScripts: HTMLScriptElement[] = [];
  vi.spyOn(document.body, "appendChild").mockImplementation(
    <T extends Node>(node: T): T => {
      if (node instanceof HTMLScriptElement) {
        appendedScripts.push(node);
      }
      return node;
    },
  );
  const executeEntrypointScript = new Function(
    "window",
    "document",
    `${getInstatusLoaderSource()}\n//# sourceURL=platform-instatus-widget-test.js`,
  ) as EntrypointScript;

  const previousAfterFirstPaint = window.__vm0AfterFirstPaint;
  const previousBrowserSupported = window.__vm0BrowserSupported;
  window.__vm0BrowserSupported = browserSupported;
  window.__vm0AfterFirstPaint = (callback) => {
    callback();
  };
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
  return appendedScripts;
}

describe("platform Instatus widget", () => {
  it.each(["app.vm0.ai", "app.okou.ai"])(
    "loads on the production hostname %s",
    (hostname) => {
      expect(loadInstatusScripts(hostname)).toStrictEqual([
        expect.objectContaining({
          crossOrigin: "anonymous",
          defer: true,
          integrity: INSTATUS_SCRIPT_INTEGRITY,
          src: INSTATUS_SCRIPT_URL,
        }),
      ]);
    },
  );

  it.each([
    "pr-22934-app.omby.ai",
    "cf-app.vm0.ai",
    "vm0.ai",
    "app.vm0.ai.evil.example",
  ])("does not load on the non-production hostname %s", (hostname) => {
    expect(loadInstatusScripts(hostname)).toStrictEqual([]);
  });

  it("does not load on an unsupported browser", () => {
    expect(loadInstatusScripts("app.vm0.ai", false)).toStrictEqual([]);
  });
});
