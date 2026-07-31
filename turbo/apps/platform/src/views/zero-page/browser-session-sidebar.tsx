import {
  IconArrowsDiagonal,
  IconAspectRatio,
  IconLoader2,
  IconPlayerStop,
  IconX,
} from "@tabler/icons-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { BrowserSessionPanel } from "./browser-session-panel.tsx";

interface BrowserSessionSidebarProps {
  readonly signals: BrowserSessionSignals;
  readonly onClose: () => void;
}

export function BrowserSessionSidebar({
  signals,
  onClose,
}: BrowserSessionSidebarProps) {
  const { t } = useTranslation();
  const fitWindow = useSet(signals.fitWindow$);
  const fittingWindow = useGet(signals.fittingWindow$);
  const stop = useSet(signals.stop$);
  const stopping = useGet(signals.stopping$);
  const sessionLoadable = useLastLoadable(signals.panelSession$);
  const pageSignal = useGet(pageSignal$);
  const canFitWindow =
    sessionLoadable.state !== "loading" &&
    sessionLoadable.state !== "hasError" &&
    sessionLoadable.data?.status === "active" &&
    sessionLoadable.data.liveUrl !== null &&
    sessionLoadable.data.screen?.resizable === true;
  const canStop =
    sessionLoadable.state !== "loading" &&
    sessionLoadable.state !== "hasError" &&
    sessionLoadable.data?.status === "active";

  const handleFitWindow = (button: HTMLButtonElement) => {
    if (!canFitWindow || fittingWindow) {
      return;
    }
    const liveViewport = button
      .closest("[data-browser-session-sidebar]")
      ?.querySelector<HTMLElement>("[data-browser-session-viewport]");
    if (!liveViewport) {
      return;
    }
    const { width, height } = liveViewport.getBoundingClientRect();
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }
    detach(
      fitWindow(width / height, pageSignal),
      Reason.DomCallback,
      "fit browser to sidebar window",
    );
  };
  return (
    <aside
      aria-label={t(($) => {
        return $.browserSession.title;
      })}
      data-browser-session-sidebar
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
        <span className="min-w-0 flex-1 text-sm font-medium">
          {t(($) => {
            return $.browserSession.title;
          })}
        </span>
        <button
          type="button"
          onClick={() => {
            detach(stop(pageSignal), Reason.DomCallback, "stop thread browser");
          }}
          disabled={!canStop || stopping}
          aria-label={t(($) => {
            return $.browserSession.stop;
          })}
          title={t(($) => {
            return $.browserSession.stop;
          })}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {stopping ? (
            <IconLoader2 className="animate-spin" size={16} />
          ) : (
            <IconPlayerStop size={16} />
          )}
        </button>
        <button
          type="button"
          onClick={(event) => {
            handleFitWindow(event.currentTarget);
          }}
          disabled={!canFitWindow || fittingWindow}
          aria-label={t(($) => {
            return $.browserSession.fitWindow;
          })}
          title={t(($) => {
            return $.browserSession.fitWindow;
          })}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          {fittingWindow ? (
            <IconLoader2 className="animate-spin" size={16} />
          ) : (
            <IconAspectRatio size={16} />
          )}
        </button>
        <a
          href={signals.href}
          target="_blank"
          rel="noreferrer"
          aria-label={t(($) => {
            return $.browserSession.openNewPage;
          })}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconArrowsDiagonal size={16} />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label={t(($) => {
            return $.browserSession.close;
          })}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <BrowserSessionPanel signals={signals} containLiveFrame />
      </div>
    </aside>
  );
}
