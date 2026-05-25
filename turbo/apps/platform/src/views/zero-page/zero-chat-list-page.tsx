// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@vm0/ui";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import { deleteChatThread$ } from "../../signals/chat-page/chat-message.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  type OptimisticChatPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  allChatThreadsExtraHasMore$,
  allChatThreadsExtraThreads$,
  allChatThreadsLatestCursor$,
  allChatThreadsLoadMoreError$,
  allChatThreadsLoadingMore$,
  loadMoreAllChatThreads$,
} from "../../signals/chat-page/all-chat-threads-pagination.ts";
import { navigateToChat$ } from "../../signals/zero-page/zero-nav.ts";
import {
  chatThreadsFirstPage$,
  currentChatThreadId$,
  currentChatAgentId$,
} from "../../signals/agent-chat.ts";
import { useChatThreadsTitleLabels } from "./zero-sidebar-shared.tsx";
import {
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";

export function ZeroChatListPage() {
  const firstPageLoadable = useLastLoadable(chatThreadsFirstPage$);
  const firstPage =
    firstPageLoadable.state === "hasData" ? firstPageLoadable.data : null;
  const loading = firstPageLoadable.state === "loading";
  const error =
    firstPageLoadable.state === "hasError"
      ? firstPageLoadable.error instanceof Error
        ? firstPageLoadable.error.message
        : "Failed to load chats"
      : null;

  const extraThreads = useGet(allChatThreadsExtraThreads$);
  const extraLatestCursor = useGet(allChatThreadsLatestCursor$);
  const extraHasMore = useGet(allChatThreadsExtraHasMore$);
  const loadingMore = useGet(allChatThreadsLoadingMore$);
  const loadMoreError = useGet(allChatThreadsLoadMoreError$);
  const loadMore = useSet(loadMoreAllChatThreads$);
  const pageSignal = useGet(pageSignal$);

  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const { titleLabel } = useChatThreadsTitleLabels();

  const selectedRecentId = useGet(currentChatThreadId$);
  const navigateToChat = useSet(navigateToChat$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const creating = useGet(optimisticChatThread$) !== null;
  const rootSignal = useGet(rootSignal$);

  const pinned = firstPage?.pinned ?? [];
  const firstPageThreads = firstPage?.threads ?? [];
  const sessions: ChatThreadListItem[] = [
    ...pinned,
    ...firstPageThreads,
    ...extraThreads,
  ];

  // Once any extra page is loaded, `extraHasMore` is the source of truth for
  // whether more remain. Before that, fall back to the first page's flag.
  const hasMore =
    extraLatestCursor !== null ? extraHasMore : (firstPage?.hasMore ?? false);
  const cursorForLoadMore = extraLatestCursor ?? firstPage?.nextCursor ?? null;

  const onNewChat = (pane: OptimisticChatPane) => {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
  };

  const onRecentSelect = (chatThreadId: string) => {
    navigateToChat(chatThreadId);
  };

  const onLoadMore = () => {
    if (!cursorForLoadMore || loadingMore) {
      return;
    }
    detach(loadMore(cursorForLoadMore, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-lg font-semibold">{titleLabel}</h1>
        </div>
      </div>

      {/* New chat button */}
      <div className="shrink-0 px-4 py-2">
        <button
          type="button"
          onClick={(event) => {
            onNewChat(event.altKey ? "sidebar" : "main");
          }}
          disabled={!currentChatAgentId || creating}
          className="flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <IconPlus size={16} stroke={2} />
          New chat
        </button>
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-auto px-4 pb-4">
        <ChatList
          loading={loading}
          error={error}
          sessions={sessions}
          selectedRecentId={selectedRecentId}
          onRecentSelect={onRecentSelect}
          hasMore={hasMore}
          loadingMore={loadingMore}
          loadMoreError={loadMoreError}
          onLoadMore={onLoadMore}
        />
      </div>
    </div>
  );
}

function ChatList({
  loading,
  error,
  sessions,
  selectedRecentId,
  onRecentSelect,
  hasMore,
  loadingMore,
  loadMoreError,
  onLoadMore,
}: {
  loading: boolean;
  error: string | null;
  sessions: ChatThreadListItem[];
  selectedRecentId: string | null;
  onRecentSelect: (id: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
}) {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const setDelete = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(setDelete(threadId, pageSignal), Reason.DomCallback);
  }

  if (loading && sessions.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {["w-3/4", "w-1/2", "w-2/3", "w-4/5", "w-3/5"].map((w) => {
          return (
            <div key={w} className="flex h-12 items-center rounded-lg px-3">
              <Skeleton className={`h-4 ${w}`} />
            </div>
          );
        })}
      </div>
    );
  }

  if (error) {
    return <p className="px-3 py-4 text-sm text-destructive">{error}</p>;
  }

  if (sessions.length === 0) {
    return (
      <p className="px-3 py-8 text-sm text-muted-foreground text-center">
        Start a conversation and it&apos;ll show up here
      </p>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        {sessions.map((session) => {
          return (
            <ChatListItem
              key={session.id}
              session={session}
              isSelected={selectedRecentId === session.id}
              onSelect={onRecentSelect}
              onDelete={() => {
                return setPendingDeleteThreadId(session.id);
              }}
            />
          );
        })}
      </div>

      {hasMore && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={loadingMore}
            onClick={onLoadMore}
            data-testid="chat-list-load-more"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
          {loadMoreError && (
            <p className="text-xs text-destructive">{loadMoreError}</p>
          )}
        </div>
      )}

      <Dialog
        open={pendingDeleteThreadId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteThreadId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This will permanently delete this chat. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                return setPendingDeleteThreadId(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ChatListItem({
  session,
  isSelected,
  onSelect,
  onDelete,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative">
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: session.id } }}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }
          e.preventDefault();
          onSelect(session.id);
        }}
        className={`flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors ${
          isSelected
            ? "bg-accent text-accent-foreground font-medium"
            : "text-foreground hover:bg-accent/50"
        }`}
      >
        <span className="truncate min-w-0 flex-1">
          {session.title ?? "New chat"}
        </span>
      </Link>
      <div className="absolute right-2 top-0 flex h-12 items-center">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete();
          }}
          className="flex h-8 w-8 items-center justify-center rounded-md invisible group-hover:visible text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          aria-label="Delete chat"
        >
          <IconTrash size={14} stroke={2} />
        </button>
      </div>
    </div>
  );
}
