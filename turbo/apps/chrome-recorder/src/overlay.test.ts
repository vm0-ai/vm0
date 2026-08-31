import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecorderStateSnapshot } from "./messages.ts";
import { formatElapsed, OVERLAY_HOST_ID, RecorderOverlay } from "./overlay.ts";

const READY: RecorderStateSnapshot = {
  elapsedSeconds: 0,
  microphone: false,
  status: "ready",
  tabAudio: true,
};

function callbacks() {
  return {
    onCancel: vi.fn(),
    onFinish: vi.fn(),
    onMicrophone: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStart: vi.fn(),
  };
}

function shadow(): ShadowRoot {
  const host = document.getElementById(OVERLAY_HOST_ID);
  if (!host?.shadowRoot) {
    throw new Error("The overlay host is not mounted");
  }
  return host.shadowRoot;
}

function click(selector: string): void {
  const button = shadow().querySelector<HTMLElement>(selector);
  if (!button) {
    throw new Error(`No overlay element matches ${selector}`);
  }
  button.click();
}

function text(selector: string): string {
  return shadow().querySelector(selector)?.textContent ?? "";
}

let overlay: RecorderOverlay | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  overlay?.destroy();
  overlay = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("RecorderOverlay", () => {
  it("starts capture only after the on-page countdown reaches zero", () => {
    const handlers = callbacks();
    overlay = new RecorderOverlay(handlers);
    overlay.prepare(READY);
    expect(overlay.mode).toBe("ready");

    click(".primary");
    expect(overlay.mode).toBe("countdown");
    expect(text(".countdown-value")).toBe("3");
    expect(handlers.onStart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(text(".countdown-value")).toBe("2");
    vi.advanceTimersByTime(1600);

    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    expect(overlay.mode).toBe("recording");
  });

  it("shows the tab audio state and toggles the microphone through the worker", () => {
    const handlers = callbacks();
    overlay = new RecorderOverlay(handlers);
    overlay.prepare(READY);

    expect(text("[data-option='tab-audio'] .option-value")).toBe("On");
    click("[data-option='microphone']");
    expect(handlers.onMicrophone).toHaveBeenCalledWith(true);

    overlay.update({ ...READY, microphone: true });
    click("[data-option='microphone']");
    expect(handlers.onMicrophone).toHaveBeenLastCalledWith(false);
  });

  it("swaps the controller between pause and resume and keeps time running", () => {
    const handlers = callbacks();
    overlay = new RecorderOverlay(handlers);
    overlay.prepare(READY);

    overlay.update({ ...READY, elapsedSeconds: 8, status: "recording" });
    expect(overlay.mode).toBe("recording");
    expect(text(".elapsed")).toBe("00:08");

    vi.advanceTimersByTime(2000);
    expect(text(".elapsed")).toBe("00:10");

    click(".controller .pill-button");
    expect(handlers.onPause).toHaveBeenCalledTimes(1);

    overlay.update({ ...READY, elapsedSeconds: 10, status: "paused" });
    vi.advanceTimersByTime(3000);
    expect(text(".elapsed")).toBe("00:10");

    click(".controller .pill-button");
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
  });

  it("blurs a picked element and reports the count on the ready panel", () => {
    const target = document.createElement("div");
    target.id = "customer-email";
    document.body.append(target);
    vi.spyOn(document, "elementFromPoint").mockReturnValue(target);

    overlay = new RecorderOverlay(callbacks());
    overlay.prepare(READY);
    click("[data-option='blur']");
    expect(overlay.mode).toBe("blur");

    document.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }),
    );

    expect(target.style.getPropertyValue("filter")).toBe("blur(10px)");
    expect(overlay.blurCount).toBe(1);
    expect(text(".blur-count")).toBe("1 blurred");

    click(".pill-button.confirm");
    expect(overlay.mode).toBe("ready");
    expect(text("[data-option='blur'] .option-value")).toBe("1 blurred");
  });

  it("explains why a recording stopped", () => {
    overlay = new RecorderOverlay(callbacks());
    overlay.prepare(READY);
    overlay.showError("microphone-permission");

    expect(text(".notice")).toContain("Chrome blocked microphone access");
  });
});

describe("formatElapsed", () => {
  it("renders minutes and seconds with a stable width", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9.8)).toBe("00:09");
    expect(formatElapsed(605)).toBe("10:05");
  });
});
