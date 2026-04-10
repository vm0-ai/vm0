// lighthouse-ci: trigger platform-changed detection
import { initSentry, Sentry } from "./lib/sentry.ts";
import "./polyfill.ts";
import { createRoot } from "react-dom/client";
import { toast } from "@vm0/ui/components/ui/sonner";
import { appStore, AppStoreProvider } from "./signals/app-store.ts";
import { bootstrap$ } from "./signals/bootstrap.ts";
import { setLogErrorHandler } from "./signals/log.ts";
import { initTheme$ } from "./signals/theme.ts";
import { detach, Reason } from "./signals/utils.ts";
import { setupRouter } from "./views/main.tsx";
import { registerServiceWorker } from "./lib/push-notifications.ts";
import { detachedNavigateTo$ } from "./signals/route.ts";

// Initialize Sentry before bootstrap so errors during startup are captured
initSentry();

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

function handleBillingRedirect() {
  const url = new URL(window.location.href);
  const billing = url.searchParams.get("billing");
  if (!billing) {
    return;
  }

  url.searchParams.delete("billing");
  window.history.replaceState(null, "", url.toString());

  // Defer toast until Toaster component is mounted
  if (billing === "success") {
    window.addEventListener(
      "load",
      () => {
        toast.success("Upgraded to Max! Your credits have been added.");
      },
      { once: true },
    );
  }
}

async function main(rootEl: HTMLDivElement, signal: AbortSignal) {
  handleBillingRedirect();

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

// Register service worker for push notifications (fire-and-forget)
detach(registerServiceWorker(), Reason.Entrance, "sw-register");

// Listen for notification clicks from service worker — navigate via client
// router to avoid a full page reload.
navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type === "NOTIFICATION_CLICK" && event.data.url) {
    const match = /^\/chats\/(.+)$/.exec(event.data.url as string);
    if (match) {
      appStore.set(detachedNavigateTo$, "/chats/:threadId", {
        pathParams: { threadId: match[1] },
      });
    }
  }
});
