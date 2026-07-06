import { StrictMode } from "react";
import type { Store } from "ccstate";
import { StoreProvider } from "ccstate-react";
import { Toaster } from "@vm0/ui/components/ui/sonner";
import { ErrorBoundary } from "./error-boundary.tsx";
import { AppSkeletonOverlay, Router } from "./router.tsx";
import { VM0ClerkProvider } from "./clerk/clerk-provider.tsx";
import { InspectLogFileInput } from "./inspect-log-file-input.tsx";
import {
  subscribeChatThreadReadCursorUpdated$,
  subscribeThreadListChanged$,
} from "../signals/chat-thread-list-reload.ts";
import { subscribeBackgroundChatThreadRunFinished$ } from "../signals/chat-page/background-chat-thread-cache.ts";
import { subscribeEventDrivenChatThreads$ } from "../signals/chat-page/chat-thread-event-sourcing.ts";
import { rootSignal$ } from "../signals/root-signal.ts";
import { detach, Reason } from "../signals/utils.ts";
import { IN_VITEST } from "../env.ts";
import "./css/index.css";

export const setupRouter = (
  store: Store,
  render: (children: React.ReactNode) => void,
) => {
  const signal = store.get(rootSignal$);
  detach(store.set(subscribeThreadListChanged$, signal), Reason.Daemon);
  detach(
    store.set(subscribeChatThreadReadCursorUpdated$, signal),
    Reason.Daemon,
  );
  detach(
    store.set(subscribeBackgroundChatThreadRunFinished$, signal),
    Reason.Daemon,
  );
  detach(store.set(subscribeEventDrivenChatThreads$, signal), Reason.Daemon);
  render(
    <StrictMode>
      <StoreProvider value={store}>
        <ErrorBoundary>
          <AppSkeletonOverlay />
          <VM0ClerkProvider>
            <Router />
          </VM0ClerkProvider>
          <InspectLogFileInput />
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
