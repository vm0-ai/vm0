import { Button, cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import {
  activeSidebarBrowserSessionId$,
  openThreadBrowserSession$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";

interface BrowserSessionCardProps {
  readonly signals: BrowserSessionSignals;
}

const BROWSER_SESSION_CARD_CLASS =
  "flex h-12 w-[268px] max-w-full items-center gap-2 rounded-[var(--zero-card-radius)] border bg-card py-1.5 pl-3 pr-1.5";

function BrowserSessionCardSkeleton() {
  return (
    <div
      className={cn(
        BROWSER_SESSION_CARD_CLASS,
        "animate-pulse border-border/70",
      )}
    >
      <span className="h-4 w-24 rounded bg-muted/70" />
      <span className="h-3 w-10 rounded bg-muted/60" />
      <span className="ml-auto h-9 w-[58px] rounded-lg bg-muted/70" />
    </div>
  );
}

function BrowserSessionUnavailable() {
  const { t } = useTranslation();
  return (
    <div
      data-browser-session-card
      data-browser-session-status="unavailable"
      className={cn(BROWSER_SESSION_CARD_CLASS, "border-border/60 opacity-70")}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {t(($) => {
            return $.browserSession.cardTitle;
          })}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/50" />
          {t(($) => {
            return $.browserSession.status.stopped;
          })}
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        disabled
        aria-label={t(($) => {
          return $.browserSession.unavailable.title;
        })}
        className="min-w-[58px] bg-foreground px-2.5 text-xs text-background hover:bg-foreground/90 active:bg-foreground/80"
      >
        {t(($) => {
          return $.browserSession.openAction;
        })}
      </Button>
    </div>
  );
}

// A fixed-height entry point. The live view is heavy and resizes as pages load,
// so it lives in the right sidebar instead of inside the message stream.
export function BrowserSessionCard({ signals }: BrowserSessionCardProps) {
  const { t } = useTranslation();
  const sessionLoadable = useLastLoadable(signals.session$);
  const selectedBrowserId = useGet(activeSidebarBrowserSessionId$);
  const openSidebar = useSet(openThreadBrowserSession$);

  if (sessionLoadable.state === "loading") {
    return <BrowserSessionCardSkeleton />;
  }
  if (sessionLoadable.state === "hasError" || sessionLoadable.data === null) {
    return <BrowserSessionUnavailable />;
  }

  const session = sessionLoadable.data;
  const selected = selectedBrowserId === signals.browserId;
  const live = session.status === "active";
  return (
    <div
      data-browser-session-card
      data-browser-session-status={session.status}
      className={cn(
        BROWSER_SESSION_CARD_CLASS,
        selected ? "border-ring/60 bg-muted/20" : "border-border/70",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">
          {t(($) => {
            return $.browserSession.cardTitle;
          })}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium",
            live
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              live ? "bg-emerald-500" : "bg-muted-foreground/50",
            )}
          />
          {live
            ? t(($) => {
                return $.browserSession.status.live;
              })
            : t(($) => {
                return $.browserSession.status.stopped;
              })}
        </span>
      </span>
      <Button
        type="button"
        size="sm"
        aria-label={t(
          ($) => {
            return $.browserSession.open;
          },
          { name: session.name },
        )}
        onClick={() => {
          openSidebar(signals.browserId);
        }}
        className="min-w-[58px] bg-foreground px-2.5 text-xs text-background hover:bg-foreground/90 active:bg-foreground/80"
      >
        {t(($) => {
          return $.browserSession.openAction;
        })}
      </Button>
    </div>
  );
}
