import {
  IconBrowser,
  IconChevronRight,
  IconLoader2,
} from "@tabler/icons-react";
import type { ZeroBrowserStatus } from "@vm0/api-contracts/contracts/zero-browser";
import { cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import {
  activeSidebarBrowserSessionId$,
  openThreadBrowserSession$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { i18n } from "../../i18n/index.ts";
import { formatAppNumber } from "../../i18n/format.ts";

interface BrowserSessionCardProps {
  readonly signals: BrowserSessionSignals;
}

function statusLabel(status: ZeroBrowserStatus): string {
  switch (status) {
    case "active": {
      return i18n.t(($) => {
        return $.browserSession.status.live;
      });
    }
    case "suspended": {
      return i18n.t(($) => {
        return $.browserSession.status.suspended;
      });
    }
    case "creating":
    case "resuming": {
      return i18n.t(($) => {
        return $.browserSession.status.starting;
      });
    }
    case "stopping": {
      return i18n.t(($) => {
        return $.browserSession.status.stopping;
      });
    }
    case "error": {
      return i18n.t(($) => {
        return $.browserSession.status.error;
      });
    }
  }
}

function BrowserSessionCardSkeleton() {
  return (
    <div className="flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border border-border/70 bg-card px-4 py-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60">
        <IconLoader2 className="animate-spin text-muted-foreground" size={16} />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-2/3 rounded bg-muted/70" />
        <div className="h-3 w-1/3 rounded bg-muted/60" />
      </div>
    </div>
  );
}

function BrowserSessionUnavailable() {
  const { t } = useTranslation();
  return (
    <div
      data-browser-session-card
      data-browser-session-status="unavailable"
      className="flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border border-border/60 bg-card px-4 py-3 opacity-70"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
        <IconBrowser size={22} className="text-muted-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5 text-foreground">
          {t(($) => {
            return $.browserSession.unavailable.title;
          })}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t(($) => {
            return $.browserSession.unavailable.description;
          })}
        </span>
      </span>
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
  return (
    <button
      type="button"
      aria-label={t(
        ($) => {
          return $.browserSession.open;
        },
        { name: session.name },
      )}
      data-browser-session-card
      data-browser-session-status={session.status}
      onClick={() => {
        openSidebar(signals.browserId);
      }}
      className={cn(
        "flex min-h-[76px] w-full max-w-xl items-center gap-3 rounded-[var(--zero-card-radius)] border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        selected ? "border-ring/60 bg-muted/20" : "border-border/70",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
        <IconBrowser size={22} className="text-foreground" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5 text-foreground">
          {session.name}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.browserSession.creditsCharged;
            },
            {
              count: session.creditsCharged,
              formattedCount: formatAppNumber(session.creditsCharged),
            },
          )}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 self-center">
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[11px] font-medium",
            session.status === "active" &&
              "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
            session.status === "suspended" &&
              "bg-amber-500/10 text-amber-700 dark:text-amber-300",
            session.status !== "active" &&
              session.status !== "suspended" &&
              "bg-muted text-muted-foreground",
          )}
        >
          {statusLabel(session.status)}
        </span>
        <IconChevronRight size={16} className="text-muted-foreground" />
      </span>
    </button>
  );
}
