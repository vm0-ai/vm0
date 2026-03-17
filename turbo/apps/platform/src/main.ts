// Initialize Sentry before anything else (side-effect import)
import { Sentry } from "./lib/sentry.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { appStore, AppStoreProvider } from "./signals/app-store.ts";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { setLogErrorHandler } from "./signals/log.ts";
import { initTheme$ } from "./signals/theme.ts";
import { detach, Reason } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";

setLogErrorHandler((loggerName, args) => {
  const error = args.find((a): a is Error => a instanceof Error);
  if (error) {
    Sentry.captureException(error, {
      tags: { logger: loggerName },
    });
  } else {
    Sentry.captureMessage(args.map(String).join(" "), {
      level: "error",
      tags: { logger: loggerName },
    });
  }
});

async function main(rootEl: HTMLDivElement, signal: AbortSignal) {
  // Initialize theme before bootstrap
  detach(appStore.set(initTheme$), Reason.Entrance);

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
