import { IconArrowsDiagonal, IconX } from "@tabler/icons-react";
import { useSet } from "ccstate-react";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { closeBrowserSessionSidebar$ } from "../../signals/zero-page/browser-session-sidebar.ts";
import { BrowserSessionPanel } from "./browser-session-panel.tsx";

interface BrowserSessionSidebarProps {
  readonly signals: BrowserSessionSignals;
}

export function BrowserSessionSidebar({ signals }: BrowserSessionSidebarProps) {
  const close = useSet(closeBrowserSessionSidebar$);
  return (
    <aside
      aria-label="Live browser"
      data-browser-session-sidebar
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
        <span className="min-w-0 flex-1 text-sm font-medium">Live browser</span>
        <a
          href={signals.href}
          target="_blank"
          rel="noreferrer"
          aria-label="Open this browser in a new page"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconArrowsDiagonal size={16} />
        </a>
        <button
          type="button"
          onClick={close}
          aria-label="Close live browser"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <BrowserSessionPanel signals={signals} />
      </div>
    </aside>
  );
}
