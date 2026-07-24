import {
  IconArrowsDiagonal,
  IconBrowser,
  IconCoins,
  IconLoader2,
  IconPlayerPause,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { cn } from "@vm0/ui";
import { useGet, useLastLoadable } from "ccstate-react";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { Markdown } from "../components/markdown.tsx";

interface BrowserSessionCardProps {
  readonly signals: BrowserSessionSignals;
  readonly fullPage?: boolean;
}

function statusLabel(status: string): string {
  return status === "active"
    ? "Live"
    : status === "suspended"
      ? "Suspended"
      : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function BrowserSessionSkeleton({ fullPage }: { readonly fullPage: boolean }) {
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-[var(--zero-card-radius)] border border-border/70 bg-card",
        fullPage ? "h-full min-h-[480px]" : "aspect-video max-w-3xl",
      )}
    >
      <IconLoader2 className="animate-spin text-muted-foreground" size={20} />
    </div>
  );
}

function BrowserSessionUnavailable({
  fullPage,
}: {
  readonly fullPage: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center gap-2 rounded-[var(--zero-card-radius)] border border-border/70 bg-card text-center",
        fullPage ? "h-full min-h-[480px]" : "min-h-48 max-w-3xl",
      )}
    >
      <IconBrowser size={26} className="text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">Browser unavailable</p>
      <p className="text-xs text-muted-foreground">
        This browser does not belong to this chat or has been removed.
      </p>
    </div>
  );
}

export function BrowserSessionCard({
  signals,
  fullPage = false,
}: BrowserSessionCardProps) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.ZeroBrowser];
  if (!enabled) {
    return (
      <Markdown
        source={signals.fallbackMarkdown}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
  }
  return <EnabledBrowserSessionCard signals={signals} fullPage={fullPage} />;
}

function EnabledBrowserSessionCard({
  signals,
  fullPage,
}: Required<BrowserSessionCardProps>) {
  const sessionLoadable = useLastLoadable(signals.session$);

  if (sessionLoadable.state === "loading") {
    return <BrowserSessionSkeleton fullPage={fullPage} />;
  }
  if (sessionLoadable.state === "hasError" || sessionLoadable.data === null) {
    return <BrowserSessionUnavailable fullPage={fullPage} />;
  }

  const session = sessionLoadable.data;
  const liveUrl = session.status === "active" ? session.liveUrl : null;
  const active = liveUrl !== null;
  return (
    <section
      data-browser-session-card
      data-browser-session-status={session.status}
      className={cn(
        "flex w-full min-w-0 flex-col overflow-hidden rounded-[var(--zero-card-radius)] border border-border/70 bg-card shadow-sm",
        fullPage ? "h-full min-h-[480px]" : "max-w-3xl",
      )}
    >
      <header className="flex min-h-12 items-center gap-3 border-b border-border/60 px-3.5 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background">
          <IconBrowser size={17} className="text-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {session.name}
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            <IconCoins size={12} />
            {session.creditsCharged} credits charged
          </span>
        </span>
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
        {!fullPage ? (
          <a
            href={signals.href}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${session.name} browser in a new page`}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <IconArrowsDiagonal size={16} />
          </a>
        ) : null}
      </header>

      {active ? (
        <iframe
          src={liveUrl}
          title={`Live browser: ${session.name}`}
          referrerPolicy="no-referrer"
          allow="autoplay; clipboard-read; clipboard-write; fullscreen"
          className={cn(
            "w-full flex-1 border-0 bg-background",
            fullPage ? "min-h-0" : "aspect-video min-h-[320px]",
          )}
        />
      ) : (
        <div
          className={cn(
            "flex flex-1 flex-col items-center justify-center gap-2 bg-muted/20 px-6 text-center",
            fullPage ? "min-h-[420px]" : "min-h-[240px]",
          )}
        >
          <IconPlayerPause size={26} className="text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            Browser {statusLabel(session.status).toLowerCase()}
          </p>
          <p className="max-w-md text-xs leading-5 text-muted-foreground">
            {session.status === "suspended"
              ? "Run zero browser resume in the next run to restore this browser profile."
              : "This browser is no longer accepting live connections."}
          </p>
        </div>
      )}
    </section>
  );
}
