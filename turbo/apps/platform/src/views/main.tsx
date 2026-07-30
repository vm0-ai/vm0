import { StrictMode } from "react";
import type { Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { Toaster } from "@vm0/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { AppSkeletonOverlay, Router } from "./router.tsx";
import { VM0ClerkProvider } from "./clerk/clerk-provider.tsx";
import { ForceUpgradeDialog } from "./components/force-upgrade-dialog.tsx";
import { InspectLogFileInput } from "./inspect-log-file-input.tsx";
import { listenForceUpgradeDialog$ } from "../signals/force-upgrade.ts";
import { setupAuthenticatedDaemons$ } from "../signals/authenticated-daemons.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { detach, Reason } from "../signals/utils.ts";
import { pwaChatKeyboardGesturesEnabled$ } from "../signals/external/feature-switch.ts";
import {
  isStandalonePwa,
  setupKeyboardDismissGesture,
} from "../lib/keyboard-dismiss-gesture.ts";
import { IN_VITEST } from "../env.ts";
import "./css/index.css";

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  const signal = store.get(rootSignal$);
  let cleanupKeyboardDismissGesture: (() => void) | undefined;
  store.watch(
    (get) => {
      cleanupKeyboardDismissGesture?.();
      cleanupKeyboardDismissGesture = undefined;
      if (get(pwaChatKeyboardGesturesEnabled$) && isStandalonePwa()) {
        cleanupKeyboardDismissGesture = setupKeyboardDismissGesture();
      }
    },
    { signal, debugLabel: "pwa-chat-keyboard-gestures" },
  );
  signal.addEventListener(
    "abort",
    () => {
      cleanupKeyboardDismissGesture?.();
    },
    { once: true },
  );
  detach(store.set(setupAuthenticatedDaemons$, signal), Reason.Daemon);
  detach(
    store.set(listenForceUpgradeDialog$, signal),
    Reason.Daemon,
    "force-upgrade",
  );
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <ErrorBoundary>
          <AppSkeletonOverlay />
          <VM0ClerkProvider>
            <Router />
          </VM0ClerkProvider>
          <InspectLogFileInput />
          <ForceUpgradeDialog />
        </ErrorBoundary>
        <Toaster
          position="top-center"
          visibleToasts={1}
          duration={IN_VITEST ? Infinity : undefined}
        />
      </StoreProvider>
    </StrictMode>,
  );
};
