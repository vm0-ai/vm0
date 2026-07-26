import {
  IconBrowser,
  IconBrowserOff,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";

import {
  browserSessionReclaimHint,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
}

function PanelFrame({
  children,
  panelRef,
}: {
  readonly children: React.ReactNode;
  readonly panelRef?: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={panelRef}
      data-browser-session-panel
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background"
    >
      {children}
    </div>
  );
}

function PanelMessage({
  icon,
  title,
  description,
  action,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-muted/20 px-6 text-center">
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      {action}
    </div>
  );
}

export function BrowserSessionPanel({ signals }: BrowserSessionPanelProps) {
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const resume = useSet(signals.resume$);
  const resuming = useGet(signals.resuming$);
  const pageSignal = useGet(pageSignal$);

  if (sessionLoadable.state === "loading") {
    return (
      <PanelFrame>
        <div className="flex flex-1 items-center justify-center">
          <IconLoader2
            className="animate-spin text-muted-foreground"
            size={20}
          />
        </div>
      </PanelFrame>
    );
  }
  if (sessionLoadable.state === "hasError" || sessionLoadable.data === null) {
    return (
      <PanelFrame>
        <PanelMessage
          icon={<IconBrowserOff size={26} className="text-muted-foreground" />}
          title="Browser unavailable"
          description="This browser does not belong to this chat or has been removed."
        />
      </PanelFrame>
    );
  }

  const session = sessionLoadable.data;
  const liveUrl = session.status === "active" ? session.liveUrl : null;
  if (liveUrl === null) {
    return (
      <PanelFrame>
        <PanelMessage
          icon={<IconBrowser size={26} className="text-muted-foreground" />}
          title={
            session.status === "suspended"
              ? "Browser suspended"
              : "Browser not live"
          }
          description="Resuming restores the saved login profile and storage. The previous pages and tabs do not come back."
          action={
            <button
              type="button"
              disabled={resuming}
              data-browser-session-resume
              onClick={() => {
                detach(resume(pageSignal), Reason.DomCallback);
              }}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
            >
              {resuming ? (
                <IconLoader2 className="animate-spin" size={14} />
              ) : (
                <IconPlayerPlay size={14} />
              )}
              {resuming ? "Resuming…" : "Resume browser"}
            </button>
          }
        />
      </PanelFrame>
    );
  }

  return (
    <PanelFrame panelRef={keepAliveRef}>
      <iframe
        src={liveUrl}
        title={`Live browser: ${session.name}`}
        referrerPolicy="no-referrer"
        allow="autoplay; clipboard-read; clipboard-write; fullscreen"
        className={cn("w-full min-h-0 flex-1 border-0 bg-background")}
      />
      <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {browserSessionReclaimHint(session)}
      </p>
    </PanelFrame>
  );
}
