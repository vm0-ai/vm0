import "./lib/preview-bypass-cookie-bootstrap.ts";
import "./lib/accept-browser.ts";
import { browserUpgradeForUserAgent } from "./lib/browser-support.ts";
import { initSentry } from "./lib/sentry.ts";
import { captureFirstSkeletonPaint, initPostHog } from "./lib/posthog.ts";
import { initPlausible } from "./lib/plausible.ts";
import { setupVisualViewportKeyboardState } from "./lib/visual-viewport-keyboard.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { resolveAssistantNameForHostname } from "./signals/branding.ts";
import { detach, Reason, resetSignal } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";
import { renderUnsupportedBrowserPage } from "./views/unsupported-browser-page.tsx";

// (no-op Platform release marker refreshed again on 2026-07-31)

function startApplication(): void {
  const resetRootSignal$ = resetSignal();
  const resetViewportSettleSignal$ = resetSignal();

  // Initialize Sentry before bootstrap so errors during startup are captured
  initSentry();
  initPostHog();
  captureFirstSkeletonPaint();

  async function main() {
    const store = createStore();
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

    await store.set(
      bootstrap$,
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
      (daemon) => {
        detach(daemon, Reason.Daemon, "app realtime subscriptions");
      },
      rootSignal,
    );
  }

  detach(main(), Reason.Entrance, "main");
}

window.__appBootstrapModuleReady = performance.now();
const browserUpgrade = browserUpgradeForUserAgent(navigator.userAgent);
if (browserUpgrade) {
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
  startApplication();
}
