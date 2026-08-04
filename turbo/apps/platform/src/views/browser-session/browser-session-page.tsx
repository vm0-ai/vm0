import { useGet } from "ccstate-react";

import { browserSessionPageSignals$ } from "../../signals/browser-session/browser-session-page-state.ts";
import {
  BrowserSessionNotFound,
  BrowserSessionPanel,
} from "../zero-page/browser-session-panel.tsx";

export function BrowserSessionPage() {
  const signals = useGet(browserSessionPageSignals$);
  return (
    <main className="fixed inset-0 flex min-h-0 flex-col bg-background">
      {signals ? (
        <BrowserSessionPanel signals={signals} />
      ) : (
        <BrowserSessionNotFound />
      )}
    </main>
  );
}
