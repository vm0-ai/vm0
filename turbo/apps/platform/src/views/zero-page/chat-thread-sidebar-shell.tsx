import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useGet, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";

import {
  CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH,
  CHAT_THREAD_SIDEBAR_MIN_WIDTH,
  chatThreadSidebarResizing$,
  chatThreadSidebarWidth$,
  startChatThreadSidebarResize$,
} from "../../signals/chat-page/chat-thread-sidebar-layout.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

function chatThreadSidebarLayout(
  width: number | null,
  resizing: boolean,
): { style: CSSProperties; transition: string } {
  const widthValue =
    width === null
      ? "min(760px, 48vw)"
      : `clamp(${CHAT_THREAD_SIDEBAR_MIN_WIDTH}px, ${width}px, calc(100% - ${CHAT_THREAD_SIDEBAR_MIN_THREAD_WIDTH}px))`;
  return {
    style: { "--chat-thread-sidebar-width": widthValue } as CSSProperties,
    transition: resizing
      ? ""
      : "transition-[flex-basis,width] duration-[240ms] ease",
  };
}

function ChatThreadSidebarResizeHandle() {
  const startResize = useSet(startChatThreadSidebarResize$);
  const pageSignal = useGet(pageSignal$);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = event.currentTarget.parentElement;
    if (!container) {
      return;
    }
    event.preventDefault();
    startResize(container, pageSignal);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className="group relative hidden w-1 shrink-0 cursor-col-resize items-stretch justify-center xl:flex"
      onPointerDown={handlePointerDown}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-border"
      />
    </div>
  );
}

export function ChatThreadSidebarShell({
  children,
  open,
  sidebar,
}: {
  readonly children: ReactNode;
  readonly open: boolean;
  readonly sidebar: ReactNode;
}) {
  const { style, transition } = chatThreadSidebarLayout(
    useGet(chatThreadSidebarWidth$),
    useGet(chatThreadSidebarResizing$),
  );

  return (
    // Keep this structure stable across sidebar open/close so the chat thread
    // subtree and its scroll and keyboard state never unmount.
    <div className="flex flex-1 min-h-0 bg-transparent" style={style}>
      <div
        className={cn(
          "min-w-0 min-h-0",
          transition,
          open ? "hidden xl:flex flex-1 basis-0" : "flex flex-1",
        )}
      >
        {children}
      </div>
      {open && <ChatThreadSidebarResizeHandle />}
      <div
        className={cn(
          "flex min-h-0 min-w-0 overflow-hidden",
          transition,
          open
            ? "flex-1 basis-0 xl:w-[var(--chat-thread-sidebar-width)] xl:flex-none xl:basis-[var(--chat-thread-sidebar-width)]"
            : "pointer-events-none w-0 flex-none basis-0",
        )}
        aria-hidden={!open}
      >
        {sidebar}
      </div>
    </div>
  );
}
