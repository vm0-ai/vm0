import { afterEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./test-helpers.ts";
import {
  installBannerVisible$,
  iosInstallModalOpen$,
  setupInstallPrompt$,
  triggerInstall$,
  closeIosInstallModal$,
  dismissInstallBanner$,
} from "../pwa-install.ts";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

class BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[] = [];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  readonly prompt: () => Promise<void>;

  constructor(
    promptFn: () => Promise<void> = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined),
  ) {
    super("beforeinstallprompt", { cancelable: true, bubbles: false });
    this.userChoice = Promise.resolve({
      outcome: "accepted" as const,
      platform: "",
    });
    this.prompt = promptFn;
  }
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

function mockIOSSafari(isIOS: boolean) {
  const ua = isIOS
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}

describe("installBannerVisible$", () => {
  it("is false by default (no deferred prompt, not iOS Safari)", () => {
    mockMatchMedia(false);
    mockIOSSafari(false);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is false when running in standalone mode", () => {
    mockMatchMedia(true);
    mockIOSSafari(true);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is true when on iOS Safari (no deferred prompt)", () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    expect(context.store.get(installBannerVisible$)).toBeTruthy();
  });

  it("is false after banner is dismissed", () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    context.store.set(dismissInstallBanner$);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is true when a deferred install prompt is captured via setupInstallPrompt$", () => {
    mockMatchMedia(false);
    mockIOSSafari(false);

    context.store.set(setupInstallPrompt$, context.signal);
    window.dispatchEvent(new BeforeInstallPromptEvent());

    expect(context.store.get(installBannerVisible$)).toBeTruthy();
  });
});

describe("iosInstallModalOpen$", () => {
  it("is false by default", () => {
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("opens when triggerInstall$ is called on iOS Safari with no deferred prompt", async () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();
  });

  it("closes via closeIosInstallModal$", async () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();

    context.store.set(closeIosInstallModal$);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("does not open when not iOS Safari and no deferred prompt", async () => {
    mockMatchMedia(false);
    mockIOSSafari(false);
    await context.store.set(triggerInstall$, context.signal);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });
});

describe("triggerInstall$ with deferred prompt", () => {
  it("calls prompt() and clears banner after install", async () => {
    mockMatchMedia(false);
    mockIOSSafari(false);

    const mockPromptFn = vi
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);

    context.store.set(setupInstallPrompt$, context.signal);
    window.dispatchEvent(new BeforeInstallPromptEvent(mockPromptFn));

    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    await context.store.set(triggerInstall$, context.signal);

    expect(mockPromptFn).toHaveBeenCalledOnce();
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });
});

describe("setupInstallPrompt$", () => {
  it("clears deferred prompt on appinstalled event", () => {
    mockMatchMedia(false);
    mockIOSSafari(false);

    context.store.set(setupInstallPrompt$, context.signal);
    window.dispatchEvent(new BeforeInstallPromptEvent());
    expect(context.store.get(installBannerVisible$)).toBeTruthy();

    window.dispatchEvent(new Event("appinstalled"));
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });
});
