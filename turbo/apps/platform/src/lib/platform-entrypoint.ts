import "./preview-bypass-cookie-bootstrap.ts";
import "./accept-browser.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { browserUpgradeForUserAgent } from "./browser-support.ts";
import { initGoogleAds } from "./google-ads.ts";
import { scheduleIOSPWAStartupImages } from "./ios-pwa-startup-image.ts";
import { initSentry } from "./sentry.ts";
import { captureFirstSkeletonPaint, initPostHog } from "./posthog.ts";
import { initPlausible } from "./plausible.ts";
import { setupVisualViewportKeyboardState } from "./visual-viewport-keyboard.ts";
import "../polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore, type Store } from "ccstate";
import { bootstrap$ } from "../signals/bootstrap.ts";
import { resolveAssistantNameForHostname } from "../signals/branding.ts";
import { featureSwitch$ } from "../signals/external/feature-switch.ts";
import { detach, Reason, resetSignal } from "../signals/utils.ts";
import { setupRouter } from "../views/main.tsx";
import { renderUnsupportedBrowserPage } from "../views/unsupported-browser-page.tsx";

// (no-op Platform release marker refreshed again on 2026-07-31)

function startApplication(): Store {
  const store = createStore();
  const resetRootSignal$ = resetSignal();
  const resetViewportSettleSignal$ = resetSignal();

  // Initialize Sentry before bootstrap so errors during startup are captured
  initSentry();
  initPostHog();
  captureFirstSkeletonPaint();

  async function main() {
    const rootSignal = store.set(resetRootSignal$);
    window.addEventListener(
      "pagehide",
      (event) => {
        if (!event.persisted) {
          store.set(resetRootSignal$);
        }
      },
      { signal: rootSignal },
    );
    detach(initPlausible(rootSignal), Reason.Entrance, "initPlausible");
    setupVisualViewportKeyboardState(rootSignal, () => {
      return store.set(resetViewportSettleSignal$, rootSignal);
    });

    const runtime = store.set(
      bootstrap$,
      __OKOU_APP_VERSION__,
      () => {
        setupRouter(store, (el) => {
          const rootEl = document.getElementById("root");
          if (!rootEl) {
            throw new Error("can't find root el to load whole app");
          }
          const root = createRoot(rootEl);
          root.render(el);
          rootSignal.addEventListener("abort", () => {
            root.unmount();
          });
        });
      },
      rootSignal,
    );
    detach(
      runtime.sharedDatabaseDaemon,
      Reason.Daemon,
      "shared database bridge",
    );
    detach(
      runtime.authenticatedRealtimeDaemon,
      Reason.Daemon,
      "app realtime subscriptions",
    );
    await runtime.ready;
  }

  detach(main(), Reason.Entrance, "main");
  return store;
}

export function startPlatformEntrypoint(): void {
  window.__appBootstrapModuleReady = performance.now();
  const browserUpgrade = browserUpgradeForUserAgent(navigator.userAgent);
  let store: Store;
  if (browserUpgrade) {
    store = createStore();
    const rootElement = document.getElementById("root");
    if (!rootElement) {
      throw new Error("can't find root el to render unsupported browser page");
    }
    renderUnsupportedBrowserPage(
      rootElement,
      resolveAssistantNameForHostname(location.hostname),
      browserUpgrade,
    );
  } else {
    store = startApplication();
  }
  initGoogleAds();
  scheduleIOSPWAStartupImages(
    store.get(featureSwitch$)[FeatureSwitchKey.IosPwaStartupImages],
  );
}
