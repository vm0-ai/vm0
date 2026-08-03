import {
  IconBrowser,
  IconBrowserOff,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import {
  ZERO_BROWSER_INITIAL_SCREEN_HEIGHT,
  ZERO_BROWSER_SCREEN_WIDTH,
} from "@vm0/api-contracts/contracts/zero-browser";
import { cn } from "@vm0/ui";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import {
  browserSessionReclaimHint,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ArtifactThumbnailImage } from "./zero-artifact-thumbnail.tsx";

interface BrowserSessionPanelProps {
  readonly signals: BrowserSessionSignals;
  readonly containLiveFrame?: boolean;
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
  className,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
  readonly action?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center",
        className ?? "bg-muted/20",
      )}
    >
      {icon}
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-md text-xs leading-5 text-muted-foreground">
        {description}
      </p>
      {action}
    </div>
  );
}

function LiveBrowserFrame({
  liveUrl,
  title,
  contain,
  aspectRatio,
}: {
  readonly liveUrl: string;
  readonly title: string;
  readonly contain: boolean;
  readonly aspectRatio: number;
}) {
  return (
    <iframe
      src={liveUrl}
      title={title}
      referrerPolicy="no-referrer"
      allow="autoplay; clipboard-read; clipboard-write; fullscreen"
      style={
        contain
          ? {
              aspectRatio: String(aspectRatio),
              width: `min(100cqw, calc(100cqh * ${String(aspectRatio)}))`,
            }
          : undefined
      }
      className={cn(
        "border-0 bg-background",
        contain
          ? "block h-auto max-h-full max-w-full shrink-0"
          : "w-full min-h-0 flex-1",
      )}
    />
  );
}

function PausedBrowserSession({
  screenshotUrl,
  containLiveFrame,
  starting,
  onStart,
}: {
  readonly screenshotUrl?: string | null;
  readonly containLiveFrame: boolean;
  readonly starting: boolean;
  readonly onStart: () => void;
}) {
  const { t } = useTranslation();
  const showScreenshot = containLiveFrame && screenshotUrl;
  const pausedMessage = (
    <PanelMessage
      icon={<IconBrowser size={26} className="text-muted-foreground" />}
      title={t(($) => {
        return $.browserSession.panel.notLive;
      })}
      description={t(($) => {
        return $.browserSession.panel.startDescription;
      })}
      action={
        <button
          type="button"
          disabled={starting}
          data-browser-session-start
          onClick={onStart}
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-70"
        >
          {starting ? (
            <IconLoader2 className="animate-spin" size={14} />
          ) : (
            <IconPlayerPlay size={14} />
          )}
          {starting
            ? t(($) => {
                return $.browserSession.panel.starting;
              })
            : t(($) => {
                return $.browserSession.panel.start;
              })}
        </button>
      }
      className={
        showScreenshot
          ? "absolute inset-0 z-10 bg-background/50 backdrop-blur-md"
          : undefined
      }
    />
  );
  if (!showScreenshot) {
    return <PanelFrame>{pausedMessage}</PanelFrame>;
  }
  return (
    <PanelFrame>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/20">
        <ArtifactThumbnailImage
          src={screenshotUrl}
          testId="browser-session-panel-screenshot"
          className="absolute inset-x-0 top-0 h-auto w-full object-contain object-top"
          fallback={
            <span className="absolute inset-0 bg-muted/20" aria-hidden />
          }
        />
        <div data-browser-session-screenshot-mask>{pausedMessage}</div>
      </div>
    </PanelFrame>
  );
}

export function BrowserSessionPanel({
  signals,
  containLiveFrame = false,
}: BrowserSessionPanelProps) {
  const { t } = useTranslation();
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const autoFitViewportRef = useSet(signals.autoFitViewportRef$);
  const keepAliveRef = useSet(signals.keepAliveRef$);
  const start = useSet(signals.start$);
  const starting = useGet(signals.starting$);
  const pageSignal = useGet(pageSignal$);

  if (sessionLoadable.state === "loading") {
    return (
      <PanelFrame>
        <div role="status" className="flex flex-1 items-center justify-center">
          <IconLoader2
            className="animate-spin text-muted-foreground"
            size={20}
          />
          <span className="sr-only">
            {t(($) => {
              return $.browserSession.status.starting;
            })}
          </span>
        </div>
      </PanelFrame>
    );
  }
  if (sessionLoadable.state === "hasError") {
    return (
      <PanelFrame>
        <PanelMessage
          icon={<IconBrowserOff size={26} className="text-muted-foreground" />}
          title={t(($) => {
            return $.browserSession.unavailable.title;
          })}
          description={t(($) => {
            return $.browserSession.unavailable.description;
          })}
        />
      </PanelFrame>
    );
  }

  const session = sessionLoadable.data;
  const liveUrl = session?.status === "active" ? session.liveUrl : null;
  if (liveUrl === null) {
    return (
      <PausedBrowserSession
        screenshotUrl={session?.screenshotUrl}
        containLiveFrame={containLiveFrame}
        starting={starting}
        onStart={() => {
          detach(start(pageSignal), Reason.DomCallback);
        }}
      />
    );
  }

  if (!session) {
    throw new Error("Live managed browser session is unavailable");
  }
  const browserAspectRatio = session.screen
    ? session.screen.width / session.screen.height
    : ZERO_BROWSER_SCREEN_WIDTH / ZERO_BROWSER_INITIAL_SCREEN_HEIGHT;
  const liveFrame = (
    <LiveBrowserFrame
      liveUrl={liveUrl}
      title={t(
        ($) => {
          return $.browserSession.iframeTitle;
        },
        { name: session.name },
      )}
      contain={containLiveFrame}
      aspectRatio={browserAspectRatio}
    />
  );

  return (
    <PanelFrame panelRef={keepAliveRef}>
      {containLiveFrame ? (
        <div
          ref={autoFitViewportRef}
          data-browser-session-viewport
          style={{ containerType: "size" }}
          className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20"
        >
          {liveFrame}
        </div>
      ) : (
        liveFrame
      )}
      <p className="border-t border-border/60 px-3.5 py-2 text-[11px] leading-4 text-muted-foreground">
        {browserSessionReclaimHint(session)}
      </p>
    </PanelFrame>
  );
}
