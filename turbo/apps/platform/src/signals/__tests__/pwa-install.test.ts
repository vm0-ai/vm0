import { afterEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./test-helpers.ts";
import {
  installBannerVisible$,
  iosInstallModalOpen$,
  triggerInstall$,
  closeIosInstallModal$,
  dismissInstallBanner$,
} from "../pwa-install.ts";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

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
  it("is false by default (not iOS Safari)", () => {
    mockMatchMedia(false);
    mockIOSSafari(false);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is false when running in standalone mode", () => {
    mockMatchMedia(true);
    mockIOSSafari(true);
    expect(context.store.get(installBannerVisible$)).toBeFalsy();
  });

  it("is true when on iOS Safari", () => {
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
});

describe("iosInstallModalOpen$", () => {
  it("is false by default", () => {
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("opens when triggerInstall$ is called on iOS Safari", () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    context.store.set(triggerInstall$);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();
  });

  it("closes via closeIosInstallModal$", () => {
    mockMatchMedia(false);
    mockIOSSafari(true);
    context.store.set(triggerInstall$);
    expect(context.store.get(iosInstallModalOpen$)).toBeTruthy();

    context.store.set(closeIosInstallModal$);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });

  it("does not open when not iOS Safari", () => {
    mockMatchMedia(false);
    mockIOSSafari(false);
    context.store.set(triggerInstall$);
    expect(context.store.get(iosInstallModalOpen$)).toBeFalsy();
  });
});
