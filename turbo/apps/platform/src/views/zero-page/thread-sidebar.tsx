import type { UIEvent as ReactUIEvent } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowLeft,
  IconMaximize,
  IconMinimize,
  IconX,
} from "@tabler/icons-react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { cn } from "@vm0/ui";

import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  classifyChatAttachment,
  previewAttachmentFromUrl,
} from "../../signals/chat-page/parse-body-blocks.ts";
import { openThreadArtifacts$ } from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/chat-thread-signals.ts";
import type {
  ArtifactRef,
  ThreadSidebarArtifactSource,
  ThreadSidebarTarget,
} from "../../signals/chat-page/thread-sidebar.ts";
import { artifactDetailPreview } from "../../signals/artifacts-page/artifact-catalog-signals.ts";
import {
  ArtifactCatalogEmpty,
  ArtifactCatalogError,
  ArtifactCatalogGrid,
  ArtifactCatalogSkeleton,
} from "../artifacts-page/artifact-catalog-page.tsx";
import { BrowserSessionSidebar } from "./browser-session-sidebar.tsx";
import { MailDraftSidebar } from "./mail-draft-sidebar.tsx";
import { ArtifactSidebar } from "./zero-artifact-sidebar.tsx";

// ---------------------------------------------------------------------------
// Thread-owned utility sidebar content.
//
// The outer ChatThreadSidebarShell owns width, resize, and the responsive
// split. This module chooses among the five mutually exclusive bodies and
// routes Close/Back/fullscreen into the owning thread's `sidebar` signals.
// ---------------------------------------------------------------------------

const ARTIFACT_AUTO_LOAD_THRESHOLD_PX = 800;

const THREAD_SIDEBAR_FULLSCREEN_CLASSNAME =
  "fixed inset-0 z-[100] flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";

function artifactRefFromUrl(url: string): ArtifactRef {
  const attachment = previewAttachmentFromUrl(url);
  return {
    url,
    kind: classifyChatAttachment(attachment),
    filename: attachment.filename,
  };
}

/**
 * Open the thread's artifacts list and start its sidebar session (background
 * first-page refresh plus realtime catalog updates). Entry buttons and the
 * detail's Back action share this hook so the session always starts.
 */
export function useOpenThreadArtifacts(thread: ChatThreadSignals): () => void {
  const open = useSet(openThreadArtifacts$);
  const setupSession = useSet(thread.sidebar.setupArtifactsSession$);
  const pageSignal = useGet(pageSignal$);
  return () => {
    open(thread);
    detach(
      setupSession(pageSignal),
      Reason.DomCallback,
      "thread artifacts sidebar session",
    );
  };
}

function ThreadSidebarHeader({
  title,
  fullscreen,
  onToggleFullscreen,
  onBack,
  onClose,
}: {
  readonly title: string;
  readonly fullscreen?: boolean;
  readonly onToggleFullscreen?: () => void;
  readonly onBack?: () => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to artifacts"
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconArrowLeft size={16} />
        </button>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      {onToggleFullscreen ? (
        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          data-testid="thread-sidebar-fullscreen-toggle"
          className="hidden xl:inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          {fullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title.toLowerCase()}`}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <IconX size={16} />
      </button>
    </div>
  );
}

function ThreadArtifactsPanel({ thread }: { thread: ChatThreadSignals }) {
  const sidebar = thread.sidebar;
  const catalogLoadable = useLastLoadable(sidebar.artifactCatalog.catalog$);
  const fullscreen = useGet(sidebar.fullscreen$);
  const toggleFullscreen = useSet(sidebar.toggleFullscreen$);
  const close = useSet(sidebar.close$);
  const open = useSet(sidebar.open$);
  const loadMore = useSet(sidebar.artifactCatalog.loadMore$);
  const pageSignal = useGet(pageSignal$);

  // useLastLoadable keeps the previously resolved pages rendered while the
  // session's background refresh replaces the first page, so reopening the
  // sidebar never falls back to the skeleton once data exists.
  const artifacts =
    catalogLoadable.state === "hasData" ? catalogLoadable.data.artifacts : null;
  const hasMore =
    catalogLoadable.state === "hasData" &&
    catalogLoadable.data.nextCursor !== null;

  const handleScroll = (event: ReactUIEvent<HTMLElement>) => {
    if (!hasMore) {
      return;
    }
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom > ARTIFACT_AUTO_LOAD_THRESHOLD_PX) {
      return;
    }
    detach(
      loadMore(pageSignal),
      Reason.DomCallback,
      "thread artifacts sidebar paging",
    );
  };

  const panel = (
    <aside
      aria-label="Artifacts"
      data-testid="thread-sidebar-artifacts"
      className={cn(
        fullscreen
          ? THREAD_SIDEBAR_FULLSCREEN_CLASSNAME
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
      )}
    >
      <ThreadSidebarHeader
        title="Artifacts"
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onClose={close}
      />
      <div
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {artifacts === null ? (
          catalogLoadable.state === "hasError" ? (
            <ArtifactCatalogError />
          ) : (
            <ArtifactCatalogSkeleton />
          )
        ) : artifacts.length === 0 ? (
          <ArtifactCatalogEmpty />
        ) : (
          <ArtifactCatalogGrid
            artifacts={artifacts}
            onOpen={(artifactId) => {
              open({
                type: "artifact",
                source: { kind: "catalog", artifactId },
              });
            }}
          />
        )}
      </div>
    </aside>
  );
  return fullscreen && typeof document !== "undefined"
    ? createPortal(panel, document.body)
    : panel;
}

function ThreadArtifactUnavailable({
  thread,
  showBack,
}: {
  readonly thread: ChatThreadSignals;
  readonly showBack: boolean;
}) {
  const close = useSet(thread.sidebar.close$);
  const backToArtifacts = useOpenThreadArtifacts(thread);
  return (
    <aside
      aria-label="Artifact"
      data-testid="thread-sidebar-artifact-unavailable"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <ThreadSidebarHeader
        title="Artifact"
        onBack={showBack ? backToArtifacts : undefined}
        onClose={close}
      />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This artifact is no longer available.
      </div>
    </aside>
  );
}

function ThreadArtifactDetail({
  thread,
  source,
}: {
  readonly thread: ChatThreadSignals;
  readonly source: ThreadSidebarArtifactSource;
}) {
  const sidebar = thread.sidebar;
  const fullscreen = useGet(sidebar.fullscreen$);
  const toggleFullscreen = useSet(sidebar.toggleFullscreen$);
  const close = useSet(sidebar.close$);
  const open = useSet(sidebar.open$);
  const backToArtifacts = useOpenThreadArtifacts(thread);
  const detailLoadable = useLastLoadable(
    sidebar.artifactCatalog.selectedArtifactDetail$,
  );

  const fullscreenState = {
    active: fullscreen,
    toggle: toggleFullscreen,
  };
  const navigateImage = (url: string) => {
    open({
      type: "artifact",
      source: { kind: "attachment", ref: artifactRefFromUrl(url) },
    });
  };

  if (source.kind === "attachment") {
    return (
      <ArtifactSidebar
        artifactRef={source.ref}
        thread={thread}
        fullscreenState={fullscreenState}
        onClose={close}
        onNavigateImage={navigateImage}
      />
    );
  }

  if (detailLoadable.state === "loading") {
    return (
      <aside
        aria-label="Artifact"
        className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
      >
        <ThreadSidebarHeader
          title="Artifact"
          onBack={backToArtifacts}
          onClose={close}
        />
        <div className="min-h-0 flex-1 px-4 py-4">
          <div className="h-full w-full animate-pulse rounded-lg bg-muted/30" />
        </div>
      </aside>
    );
  }

  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  if (!detail) {
    // 404 (or a load error) keeps the sidebar mounted so the page layout does
    // not jump; the list stays one Back away.
    return <ThreadArtifactUnavailable thread={thread} showBack />;
  }

  const preview = artifactDetailPreview(detail);
  return (
    <ArtifactSidebar
      artifactRef={{
        url: preview.url,
        kind: preview.kind,
        filename: preview.filename,
      }}
      thread={thread}
      text$={sidebar.selectedArtifactText$}
      fullscreenState={fullscreenState}
      onBack={backToArtifacts}
      onClose={close}
      onNavigateImage={navigateImage}
    />
  );
}

function ThreadMailDraftPanel({
  thread,
  mailDraftId,
}: {
  readonly thread: ChatThreadSignals;
  readonly mailDraftId: string;
}) {
  const close = useSet(thread.sidebar.close$);
  const signals = useGet(thread.mailDraftCardSignalsById$).get(mailDraftId);
  if (!signals) {
    return null;
  }
  return <MailDraftSidebar signals={signals} onClose={close} />;
}

function ThreadBrowserSessionPanel({
  thread,
  browserSessionId,
}: {
  readonly thread: ChatThreadSignals;
  readonly browserSessionId: string;
}) {
  const close = useSet(thread.sidebar.close$);
  const signals = useGet(thread.browserSessionCardSignalsById$).get(
    browserSessionId,
  );
  if (!signals) {
    return null;
  }
  return <BrowserSessionSidebar signals={signals} onClose={close} />;
}

export function ThreadSidebarSlot({
  thread,
  target,
}: {
  readonly thread: ChatThreadSignals;
  readonly target: ThreadSidebarTarget;
}) {
  switch (target.type) {
    case "artifacts": {
      return <ThreadArtifactsPanel key={thread.threadId} thread={thread} />;
    }
    case "artifact": {
      return <ThreadArtifactDetail thread={thread} source={target.source} />;
    }
    case "automations": {
      // Rendered by ZeroChatThreadPage directly: the automations body lives in
      // the page module and importing it here would create an import cycle.
      return null;
    }
    case "email-draft": {
      return (
        <ThreadMailDraftPanel
          thread={thread}
          mailDraftId={target.mailDraftId}
        />
      );
    }
    case "browser": {
      return (
        <ThreadBrowserSessionPanel
          thread={thread}
          browserSessionId={target.browserSessionId}
        />
      );
    }
  }
}
