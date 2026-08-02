import { describe, expect, it } from "vitest";
import { testContext } from "./test-helpers.ts";
import {
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  scrollChatThreadVirtualListToIndex$,
  setChatThreadVirtualListElement$,
  setOverlayScrollViewport$,
} from "../zero-page/zero-sidebar-state.ts";

const context = testContext();

function defineLayoutMetric(
  element: HTMLElement,
  key: "clientHeight" | "offsetTop" | "scrollHeight" | "scrollTop",
  value: number,
  writable = false,
): void {
  Object.defineProperty(element, key, {
    configurable: true,
    value,
    writable,
  });
}

function setupVirtualThreadList({
  scrollTop,
  viewportHeight,
}: {
  scrollTop: number;
  viewportHeight: number;
}): HTMLElement {
  const scrollViewport = document.createElement("div");
  const virtualListElement = document.createElement("div");

  defineLayoutMetric(scrollViewport, "offsetTop", 0);
  defineLayoutMetric(scrollViewport, "scrollHeight", 1000);
  defineLayoutMetric(scrollViewport, "clientHeight", viewportHeight);
  defineLayoutMetric(scrollViewport, "scrollTop", scrollTop, true);
  defineLayoutMetric(virtualListElement, "offsetTop", 0);

  context.store.set(setOverlayScrollViewport$, scrollViewport);
  context.store.set(setChatThreadVirtualListElement$, virtualListElement);
  return scrollViewport;
}

describe("zero sidebar virtual thread scrolling", () => {
  it("aligns a hidden target row bottom with the viewport bottom when requested", () => {
    const viewportHeight = CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 2;
    const scrollViewport = setupVirtualThreadList({
      scrollTop: CHAT_THREAD_VIRTUAL_ROW_HEIGHT * 20,
      viewportHeight,
    });

    context.store.set(scrollChatThreadVirtualListToIndex$, 22, "bottom");

    expect(scrollViewport.scrollTop).toBe(
      23 * CHAT_THREAD_VIRTUAL_ROW_HEIGHT - viewportHeight,
    );
  });
});
