import { describe, expect, it, vi } from "vitest";

import { initInstatusWidget } from "../lib/instatus-widget.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();

const INSTATUS_SCRIPT_URL =
  "https://api.dashboard.instatus.com/widget?host=status.okou.ai&code=02c0ef5a&locale=en";
const INSTATUS_SCRIPT_INTEGRITY =
  "sha384-YU7+0Wj4uP1wkywaN92wj9+XhrCKLPHapq5vtxjnjEQU401q3xFgN4JNkMWcBHOW";

function loadInstatusScripts(hostname: string): HTMLScriptElement[] {
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
  initInstatusWidget();
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
});
