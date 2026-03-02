// Initialize Sentry before anything else (side-effect import)
import "./lib/sentry.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { appStore, AppStoreProvider } from "./signals/app-store.ts";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { initSidebar$ } from "./signals/sidebar.ts";
import { initTheme$ } from "./signals/theme.ts";
import { detach, Reason } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";

async function main(rootEl: HTMLDivElement, signal: AbortSignal) {
  // Initialize theme and sidebar before bootstrap
  detach(appStore.set(initTheme$), Reason.Entrance);
  detach(appStore.set(initSidebar$), Reason.Entrance);

  await appStore.set(
    bootstrap$,
    () => {
      setupRouter(AppStoreProvider, (el) => {
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
  main(document.getElementById("root") as HTMLDivElement, AbortSignal.any([])),
  Reason.Entrance,
  "main",
);
