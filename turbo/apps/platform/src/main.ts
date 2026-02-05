// Initialize Sentry before anything else (side-effect import)
import "./lib/sentry.ts";
import "./polyfill.ts";
import { createStore, type Store } from "ccstate";
import { createRoot } from "react-dom/client";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { initSidebar$ } from "./signals/sidebar.ts";
import { initTheme$ } from "./signals/theme.ts";
import { detach, Reason } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";

// pass store here is allowed because main is an entrance point
// eslint-disable-next-line ccstate/no-store-in-params
async function main(rootEl: HTMLDivElement, store: Store, signal: AbortSignal) {
  // Initialize theme and sidebar before bootstrap
  detach(store.set(initTheme$), Reason.Entrance);
  detach(store.set(initSidebar$), Reason.Entrance);

  await store.set(
    bootstrap$,
    () => {
      setupRouter(store, (el) => {
        const root = createRoot(rootEl);
        root.render(el);
        signal.addEventListener("abort", () => {
          root.unmount();
        });
      });
    },
    signal,
  );
}

detach(
  main(
    document.getElementById("root") as HTMLDivElement,
    createStore(),
    AbortSignal.any([]),
  ),
  Reason.Entrance,
  "main",
);
