// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { IconPlus, IconSearch, IconX, IconTrash } from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Skeleton,
} from "@vm0/ui";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatThreads$,
  deleteChatThread$,
} from "../../signals/chat-page/chat-message.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  type OptimisticChatPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { navigateToChat$ } from "../../signals/zero-page/zero-nav.ts";
import {
  currentChatThreadId$,
  currentChatAgentId$,
} from "../../signals/agent-chat.ts";
import {
  AvatarFromUrl,
  useChatThreadsTitleLabels,
} from "./zero-sidebar-shared.tsx";
import {
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { MobileChatAgentSwitcher } from "./mobile-chat-agent-switcher.tsx";

export function ZeroChatListPage() {
  const recentSessionsLoadable = useLastLoadable(chatThreads$);
  const recentSessions =
    recentSessionsLoadable.state === "hasData"
      ? recentSessionsLoadable.data
      : [];
  const loading = recentSessionsLoadable.state === "loading";
  const error =
    recentSessionsLoadable.state === "hasError"
      ? recentSessionsLoadable.error instanceof Error
        ? recentSessionsLoadable.error.message
        : "Failed to load chats"
      : null;

  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const { searchPlaceholder } = useChatThreadsTitleLabels();

  const selectedRecentId = useGet(currentChatThreadId$);
  const navigateToChat = useSet(navigateToChat$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const creating = useGet(optimisticChatThread$) !== null;
  const rootSignal = useGet(rootSignal$);

  const searchTerm = useGet(chatListQuery$);
  const setSearchTerm = useSet(setChatListQuery$);

  const features = useLastResolved(featureSwitch$);
  const mobileNativeOn =
    features?.[FeatureSwitchKey.MobileNativeV1] ?? false;

  // Mobile-native delegates search to the dedicated /search page, so the
  // term filter only applies on desktop / non-redesign mobile.
  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions =
    !mobileNativeOn && trimmedTerm
      ? recentSessions.filter((s) => {
          return (s.title ?? "").toLowerCase().includes(trimmedTerm);
        })
      : recentSessions;

  const onNewChat = (pane: OptimisticChatPane) => {
    detach(
      createNewChat(currentChatAgentId ?? null, pane, rootSignal),
      Reason.DomCallback,
    );
  };

  const onRecentSelect = (chatThreadId: string) => {
    navigateToChat(chatThreadId);
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <MobileChatAgentSwitcher />

        {/* Always-visible search bar — desktop / non-redesign mobile only.
            Mobile-native sends the search icon to the dedicated /search page. */}
        {!mobileNativeOn && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 h-10">
            <IconSearch
              size={16}
              stroke={2}
              className="shrink-0 text-muted-foreground"
            />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                return setSearchTerm(e.target.value);
              }}
              placeholder={searchPlaceholder}
              data-testid="chat-list-search-input"
              className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm("");
                }}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <IconX size={14} stroke={2} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* New chat button — full-width on desktop, hidden on mobile-native
          (replaced by the FAB below) */}
      {!mobileNativeOn && (
        <div className="shrink-0 px-4 py-2">
          <button
            type="button"
            onClick={(event) => {
              onNewChat(event.altKey ? "sidebar" : "main");
            }}
            disabled={creating}
            className="flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            <IconPlus size={16} stroke={2} />
            New chat
          </button>
        </div>
      )}

      {/* Chat list */}
      <div
        className={cn(
          "flex-1 overflow-auto px-4",
          mobileNativeOn ? "pt-2 pb-24" : "pb-4",
        )}
      >
        <ChatList
          loading={loading}
          error={error}
          sessions={filteredSessions}
          searchTerm={searchTerm}
          selectedRecentId={selectedRecentId}
          onRecentSelect={onRecentSelect}
        />
      </div>

      {/* Floating action button — mobile-native only; sits above the bottom
          tab bar so the New chat entry stays accessible without occupying
          a full-width row. */}
      {mobileNativeOn && (
        <button
          type="button"
          onClick={() => {
            onNewChat("main");
          }}
          disabled={creating}
          aria-label="New chat"
          data-testid="mobile-new-chat-fab"
          className="md:hidden absolute right-4 bottom-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <IconPlus size={24} stroke={2} />
        </button>
      )}
    </div>
  );
}

function ChatList({
  loading,
  error,
  sessions,
  searchTerm,
  selectedRecentId,
  onRecentSelect,
}: {
  loading: boolean;
  error: string | null;
  sessions: ChatThreadListItem[];
  searchTerm: string;
  selectedRecentId: string | null;
  onRecentSelect: (id: string) => void;
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
        {searchTerm.trim()
          ? "No chats match your search"
          : "Start a conversation and it'll show up here"}
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

// Compact relative-date label for the right column of a chat list row.
// Today/Yesterday for very recent threads, M/D for the rest of this year,
// YYYY/M/D once the year flips.
function formatThreadDateLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  const startOf = (date: Date) => {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
    ).getTime();
  };
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (dayDiff === 0) {
    return "Today";
  }
  if (dayDiff === 1) {
    return "Yesterday";
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
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
  const dateLabel = formatThreadDateLabel(
    session.updatedAt ?? session.createdAt,
    new Date(),
  );
  const isUnread = !session.isRead;
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
        className={cn(
          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors no-underline",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "text-foreground hover:bg-accent/50",
        )}
      >
        <span className="relative shrink-0">
          <AvatarFromUrl
            avatarUrl={session.agent.avatarUrl}
            alt=""
            className="h-10 w-10 rounded-full object-cover object-top"
          />
          {isUnread && (
            <span
              aria-label="Unread"
              className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 flex items-center gap-2">
          <span
            className={cn(
              "truncate text-sm",
              isUnread ? "font-semibold" : "font-medium",
            )}
          >
            {session.title ?? "New chat"}
          </span>
        </span>
        {dateLabel && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {dateLabel}
          </span>
        )}
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-opacity"
        aria-label="Delete chat"
      >
        <IconTrash size={14} stroke={2} />
      </button>
    </div>
  );
}
