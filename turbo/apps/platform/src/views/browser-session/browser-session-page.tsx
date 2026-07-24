import { IconBrowserOff } from "@tabler/icons-react";
import { useGet } from "ccstate-react";

import { browserSessionPageSignals$ } from "../../signals/browser-session/browser-session-page-state.ts";
import { BrowserSessionCard } from "../zero-page/browser-session-card.tsx";

export function BrowserSessionPage() {
  const signals = useGet(browserSessionPageSignals$);
  return (
    <main className="fixed inset-0 flex min-h-0 flex-col bg-background p-3 sm:p-5">
      {signals ? (
        <BrowserSessionCard signals={signals} fullPage />
      ) : (
        <div className="flex h-full items-center justify-center rounded-[var(--zero-card-radius)] border border-border/70 bg-card">
          <div className="flex flex-col items-center gap-2 text-center">
            <IconBrowserOff size={28} className="text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">
              Invalid browser link
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
