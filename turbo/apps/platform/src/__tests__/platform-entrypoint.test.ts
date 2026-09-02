import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const INSTATUS_WIDGET_HOSTNAME = "api.dashboard.instatus.com";
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

let googleAdsRequestedAfterApplicationStart = false;

function instatusScripts(): HTMLScriptElement[] {
  return Array.from(document.scripts).filter((script) => {
    const source = script.getAttribute("src");
    if (!source) {
      return false;
    }
    return (
      new URL(source, window.location.href).hostname ===
      INSTATUS_WIDGET_HOSTNAME
    );
  });
}

describe.each(["app.vm0.ai", "app.okou.ai"])(
  "platform entrypoint on %s",
  (hostname) => {
    beforeEach(() => {
      googleAdsRequestedAfterApplicationStart = false;
      context.mocks.browser.url(`https://${hostname}/`);
      const root = document.createElement("div");
      root.id = "root";
      document.body.replaceChildren(root);

      const addEventListener = vi.spyOn(window, "addEventListener");
      const appendChild = document.head.appendChild.bind(document.head);
      vi.spyOn(document.head, "appendChild").mockImplementation(
        <T extends Node>(node: T): T => {
          if (
            node instanceof HTMLScriptElement &&
            node.src === GOOGLE_TAG_SCRIPT_URL
          ) {
            googleAdsRequestedAfterApplicationStart =
              addEventListener.mock.calls.some(([eventName]) => {
                return eventName === "pagehide";
              });
          }
          return appendChild(node);
        },
      );

      startPlatformEntrypoint();
    });

    afterEach(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    it("does not inject the Instatus widget", () => {
      expect(instatusScripts()).toStrictEqual([]);
    });

    it("starts the application before requesting Google Ads", () => {
      expect(googleAdsRequestedAfterApplicationStart).toBeTruthy();
    });
  },
);
