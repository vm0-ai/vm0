import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

function instatusScripts(): HTMLScriptElement[] {
  return Array.from(document.scripts).filter((script) => {
    return script.src.includes("instatus.com");
  });
}

describe.each(["app.vm0.ai", "app.okou.ai"])(
  "platform entrypoint on %s",
  (hostname) => {
    beforeEach(() => {
      context.mocks.browser.url(`https://${hostname}/`);
      const root = document.createElement("div");
      root.id = "root";
      document.body.replaceChildren(root);
      startPlatformEntrypoint();
    });

    afterEach(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    it("does not inject the Instatus widget", () => {
      expect(instatusScripts()).toStrictEqual([]);
    });
  },
);
