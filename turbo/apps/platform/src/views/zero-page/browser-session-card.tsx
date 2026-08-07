import { AppWindow } from "lucide-react";
import { cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import {
  activeSidebarBrowserThreadId$,
  openThreadBrowserSession$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import { ArtifactThumbnailImage } from "./zero-artifact-thumbnail.tsx";

interface BrowserSessionCardProps {
  readonly signals: BrowserSessionSignals;
}

const BROWSER_SESSION_CARD_CLASS =
  "inline-flex w-[min(100%,400px)] flex-col overflow-hidden rounded-lg border border-foreground/10 bg-background text-left align-top text-foreground shadow-sm transition-all duration-200";
const BROWSER_SESSION_CARD_HOVER_CLASS =
  "hover:scale-[1.015] hover:border-foreground/20 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30";

function BrowserSessionStatus({ live }: { readonly live: boolean }) {
  const { t } = useTranslation();
  return (
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
  );
}

function BrowserSessionPreviewPlaceholder() {
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-muted/30 text-muted-foreground">
      <AppWindow size={30} />
    </span>
  );
}

function BrowserSessionPreview({ screenshotUrl }: { screenshotUrl?: string }) {
  return (
    <span className="relative block aspect-[16/10] w-full overflow-hidden bg-muted/30">
      {screenshotUrl ? (
        <ArtifactThumbnailImage
          src={screenshotUrl}
          testId="browser-session-thumbnail"
          className="absolute inset-0 h-full w-full object-cover object-top"
          fallback={<BrowserSessionPreviewPlaceholder />}
        />
      ) : (
        <BrowserSessionPreviewPlaceholder />
      )}
    </span>
  );
}

function BrowserSessionCardSkeleton() {
  return (
    <div
      className={cn(
        BROWSER_SESSION_CARD_CLASS,
        "animate-pulse border-border/70",
      )}
    >
      <span className="flex min-h-10 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="h-4 w-24 rounded bg-muted/70" />
        <span className="ml-auto h-3 w-10 rounded bg-muted/60" />
      </span>
      <span className="block aspect-[16/10] w-full bg-muted/40" />
    </div>
  );
}

function BrowserSessionUnavailable({
  signals,
}: {
  readonly signals?: BrowserSessionSignals;
}) {
  const { t } = useTranslation();
  const openSidebar = useSet(openThreadBrowserSession$);
  const unavailable = signals === undefined;
  return (
    <button
      type="button"
      data-browser-session-card
      data-browser-session-status={unavailable ? "unavailable" : "suspended"}
      disabled={unavailable}
      aria-label={
        unavailable
          ? t(($) => {
              return $.browserSession.unavailable.title;
            })
          : t(($) => {
              return $.browserSession.openAction;
            })
      }
      onClick={() => {
        if (signals) {
          openSidebar(signals.threadId);
        }
      }}
      className={cn(
        BROWSER_SESSION_CARD_CLASS,
        unavailable
          ? "cursor-default border-border/60 opacity-70"
          : BROWSER_SESSION_CARD_HOVER_CLASS,
      )}
    >
      <span className="flex min-h-10 w-full items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t(($) => {
            return $.browserSession.cardTitle;
          })}
        </span>
        <BrowserSessionStatus live={false} />
      </span>
      <BrowserSessionPreview />
    </button>
  );
}

export function BrowserSessionCard({ signals }: BrowserSessionCardProps) {
  const { t } = useTranslation();
  const sessionLoadable = useLastLoadable(signals.session$);
  const selectedBrowserThreadId = useGet(activeSidebarBrowserThreadId$);
  const openSidebar = useSet(openThreadBrowserSession$);

  if (sessionLoadable.state === "loading") {
    return <BrowserSessionCardSkeleton />;
  }
  if (sessionLoadable.state === "hasError") {
    return <BrowserSessionUnavailable />;
  }
  if (sessionLoadable.data === null) {
    return <BrowserSessionUnavailable signals={signals} />;
  }

  const session = sessionLoadable.data;
  const selected = selectedBrowserThreadId === signals.threadId;
  const live = session.status === "active";
  return (
    <button
      type="button"
      data-browser-session-card
      data-browser-session-status={session.status}
      aria-label={t(
        ($) => {
          return $.browserSession.open;
        },
        { name: session.name },
      )}
      onClick={() => {
        openSidebar(signals.threadId);
      }}
      className={cn(
        BROWSER_SESSION_CARD_CLASS,
        BROWSER_SESSION_CARD_HOVER_CLASS,
        selected && "border-ring/60 bg-muted/20",
      )}
    >
      <span className="flex min-h-10 w-full items-center gap-2 border-b border-border/60 bg-background/95 px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t(($) => {
            return $.browserSession.cardTitle;
          })}
        </span>
        <BrowserSessionStatus live={live} />
      </span>
      <BrowserSessionPreview
        screenshotUrl={session.screenshotUrl ?? undefined}
      />
    </button>
  );
}
