import { describe, expect, it, vi } from "vitest";
import { testContext } from "./test-helpers.ts";
import {
  installBannerVisible$,
  iosInstallModalOpen$,
  setIsIOSSafari$,
  setupInstallPrompt$,
  triggerInstall$,
  closeIosInstallModal$,
  dismissInstallBanner$,
} from "../pwa-install.ts";

const context = testContext();

interface BeforeInstallPromptEventLike extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

function mockMatchMedia(standalone: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: standalone,
    media: "(display-mode: standalone)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList);
}

/**
 * Set up install prompt listeners and return helpers that trigger the
 * beforeinstallprompt and appinstalled events directly without going
 * through window.dispatchEvent.
 */
function captureWindowListeners(signal: AbortSignal): {
  fireBeforeInstallPrompt: (event: BeforeInstallPromptEventLike) => void;
  fireAppInstalled: () => void;
} {
  let promptHandler: ((e: Event) => void) | null = null;
  let installedHandler: (() => void) | null = null;

  const origAddEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      ...rest: unknown[]
    ) => {
      if (type === "beforeinstallprompt") {
        promptHandler = listener as (e: Event) => void;
      } else if (type === "appinstalled") {
        installedHandler = listener as () => void;
      }
      return origAddEventListener(
        type,
        listener as EventListener,
        ...(rest as [boolean?]),
      );
    },
  );

  context.store.set(setupInstallPrompt$, signal);

  return {
    fireBeforeInstallPrompt(event: BeforeInstallPromptEventLike) {
      promptHandler?.(event);
    },
    fireAppInstalled() {
      installedHandler?.();
    },
  };
}

function makePromptEvent(
  promptFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
): BeforeInstallPromptEventLike {
  const e = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
  Object.assign(e, {
    platforms: [],
    userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "" }),
    prompt: promptFn,
  });
  return e;
}

describe("installBannerVisible$", () => {
  it("is false by default (no deferred prompt, not iOS Safari)", () => {
    mockMatchMedia(false);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is false when running in standalone mode", () => {
    mockMatchMedia(true);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is true when on iOS Safari (no deferred prompt)", () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, true);
    expect(context.store.get(installBannerVisible$)).toBeTruthy();
  });

  it("is false after banner is dismissed", () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, true);
    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    context.store.set(dismissInstallBanner$);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is true when a deferred install prompt is captured via setupInstallPrompt$", () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, false);

    const { fireBeforeInstallPrompt } = captureWindowListeners(context.signal);
    fireBeforeInstallPrompt(makePromptEvent());

    expect(context.store.get(installBannerVisible$)).toBeTruthy();
  });
});

describe("iosInstallModalOpen$", () => {
  it("is false by default", () => {
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("opens when triggerInstall$ is called on iOS Safari with no deferred prompt", async () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, true);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();
  });

  it("closes via closeIosInstallModal$", async () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, true);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();

    context.store.set(closeIosInstallModal$);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("does not open when not iOS Safari and no deferred prompt", async () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, false);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });
});

describe("triggerInstall$ with deferred prompt", () => {
  it("calls prompt() and clears banner after install", async () => {
    mockMatchMedia(false);

    const mockPromptFn = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const { fireBeforeInstallPrompt } = captureWindowListeners(context.signal);
    fireBeforeInstallPrompt(makePromptEvent(mockPromptFn));

    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    await context.store.set(triggerInstall$, context.signal);

    expect(mockPromptFn).toHaveBeenCalledOnce();
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });
});

describe("setupInstallPrompt$", () => {
  it("clears deferred prompt on appinstalled event", () => {
    mockMatchMedia(false);
    context.store.set(setIsIOSSafari$, false);

    const { fireBeforeInstallPrompt, fireAppInstalled } =
      captureWindowListeners(context.signal);
    fireBeforeInstallPrompt(makePromptEvent());
    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    fireAppInstalled();
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });
});
