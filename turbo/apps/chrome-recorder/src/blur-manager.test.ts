import { afterEach, describe, expect, it, vi } from "vitest";

import { BlurManager, selectorForElement } from "./blur-manager.ts";

function flushFrame(): void {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BlurManager", () => {
  it("attaches blur to the element so it travels with page scroll", () => {
    const element = document.createElement("section");
    element.id = "private-account";
    document.body.append(element);
    const manager = new BlurManager(() => {});

    expect(manager.add(element)).toBe(true);
    expect(element.style.getPropertyValue("filter")).toBe("blur(10px)");
    expect(element.hasAttribute("data-okou-recorder-blurred")).toBe(true);

    manager.destroy();
    expect(element.style.getPropertyValue("filter")).toBe("");
    expect(element.hasAttribute("data-okou-recorder-blurred")).toBe(false);
  });

  it("blurs the recycled node when a virtualized list re-renders on scroll", () => {
    flushFrame();
    const original = document.createElement("div");
    original.setAttribute("data-testid", "account-balance");
    document.body.append(original);
    const manager = new BlurManager(() => {});
    manager.add(original);

    const recycled = document.createElement("div");
    recycled.setAttribute("data-testid", "account-balance");
    original.replaceWith(recycled);
    window.dispatchEvent(new Event("scroll"));

    expect(recycled.style.getPropertyValue("filter")).toBe("blur(10px)");
    manager.destroy();
  });

  it("restores blur when the page overwrites the inline filter", () => {
    flushFrame();
    const element = document.createElement("div");
    element.id = "customer-card";
    document.body.append(element);
    const manager = new BlurManager(() => {});
    manager.add(element);

    element.style.removeProperty("filter");
    window.dispatchEvent(new Event("scroll"));

    expect(element.style.getPropertyValue("filter")).toBe("blur(10px)");
    manager.destroy();
  });

  it("reports the selection count and undoes the last selection", () => {
    const counts: number[] = [];
    const first = document.createElement("div");
    first.id = "first";
    const second = document.createElement("div");
    second.id = "second";
    document.body.append(first, second);
    const manager = new BlurManager((count) => {
      counts.push(count);
    });

    manager.add(first);
    manager.add(second);
    expect(manager.add(second)).toBe(false);
    manager.undo();

    expect(counts).toEqual([1, 2, 1]);
    expect(second.style.getPropertyValue("filter")).toBe("");
    expect(first.style.getPropertyValue("filter")).toBe("blur(10px)");
    manager.destroy();
  });

  it("prefers stable attributes over positional selectors", () => {
    const element = document.createElement("div");
    element.setAttribute("data-testid", "customer-email");
    document.body.append(element);

    expect(selectorForElement(element)).toBe(
      'div[data-testid="customer-email"]',
    );
  });

  it("falls back to a structural selector when no stable attribute exists", () => {
    const wrapper = document.createElement("section");
    wrapper.id = "invoices";
    const row = document.createElement("div");
    wrapper.append(document.createElement("div"), row);
    document.body.append(wrapper);

    expect(selectorForElement(row)).toBe("#invoices > div:nth-of-type(2)");
  });
});
