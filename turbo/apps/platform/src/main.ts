import "./lib/preview-bypass-cookie-bootstrap.ts";
import { initSentry } from "./lib/sentry.ts";
import { initPostHog } from "./lib/posthog.ts";
import { initPlausible } from "./lib/plausible.ts";
import { setupVisualViewportKeyboardState } from "./lib/visual-viewport-keyboard.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { detach, Reason, resetSignal } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";

window.__appBootstrapModuleReady = performance.now();

// (no-op Platform release marker refreshed again on 2026-07-31)

const resetRootSignal$ = resetSignal();
const resetViewportSettleSignal$ = resetSignal();

// Initialize Sentry before bootstrap so errors during startup are captured
initSentry();
initPostHog();

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
    rootSignal,
  );
}

detach(main(), Reason.Entrance, "main");
