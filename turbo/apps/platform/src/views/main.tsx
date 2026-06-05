import { StrictMode } from "react";
import type { Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { Toaster } from "@vm0/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { Router } from "./router.tsx";
import { VM0ClerkProvider } from "./clerk/clerk-provider.tsx";
import { MigrateSchedulesDialogContainer } from "./zero-page/migrate-schedules-dialog.tsx";
import { subscribeThreadListChanged$ } from "../signals/chat-thread-list-reload.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { detach, Reason } from "../signals/utils.ts";
import "./css/index.css";

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  const signal = store.get(rootSignal$);
  detach(store.set(subscribeThreadListChanged$, signal), Reason.Daemon);
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <VM0ClerkProvider>
          <ErrorBoundary>
            <Router />
            <MigrateSchedulesDialogContainer />
          </ErrorBoundary>
        </VM0ClerkProvider>
        <Toaster position="top-center" visibleToasts={1} />
      </StoreProvider>
    </StrictMode>,
  );
};
