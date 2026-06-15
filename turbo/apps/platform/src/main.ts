import { initSentry, Sentry } from "./lib/sentry.ts";
import { initPostHog } from "./lib/posthog.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { createStore } from "ccstate";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { setLogErrorHandler } from "./signals/log.ts";
import { detach, Reason } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";

// Initialize Sentry before bootstrap so errors during startup are captured
initSentry();
initPostHog();

setLogErrorHandler((loggerName, args) => {
  const error = args.find((a): a is Error => {
    return a instanceof Error;
  });
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

async function main() {
  const store = createStore();
  const rootSignal = AbortSignal.any([]);

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
