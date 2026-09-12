import { useGet, useLastLoadable } from "ccstate-react";

import {
  browserSessionPageSignals$,
  type BrowserSessionPageSignals,
} from "../../signals/browser-session/browser-session-page-state.ts";
import {
  BrowserSessionLoading,
  BrowserSessionNotFound,
  BrowserSessionPanel,
  BrowserSessionUnavailable,
} from "../okou-page/browser-session-panel.tsx";

function BrowserSessionPageContent({
  signals,
}: {
  readonly signals: BrowserSessionPageSignals;
}) {
  const threadAccessible = useLastLoadable(signals.threadAccessible$);
  if (threadAccessible.state === "loading") {
    return <BrowserSessionLoading />;
  }
  if (threadAccessible.state === "hasError") {
    return <BrowserSessionUnavailable />;
  }
  return threadAccessible.data ? (
    <BrowserSessionPanel signals={signals.browser} />
  ) : (
    <BrowserSessionNotFound />
  );
}

export function BrowserSessionPage() {
  const signals = useGet(browserSessionPageSignals$);
  return (
    <main
      className="okou-app fixed inset-0 flex h-[var(--okou-viewport-height)] max-h-[var(--okou-viewport-height)] min-h-0 flex-col overflow-hidden bg-background pt-[var(--sat)] pr-[var(--sar)] pb-[var(--sab)] pl-[var(--sal)]"
      data-testid="browser-session-page"
    >
      {signals ? (
        <BrowserSessionPageContent signals={signals} />
      ) : (
        <BrowserSessionNotFound />
      )}
    </main>
  );
}
