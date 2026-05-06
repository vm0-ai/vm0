// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import {
  IconCalendarClock,
  IconMessageCircle,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
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
import { useChatThreadsTitleLabels } from "./zero-sidebar-shared.tsx";
import {
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  chatListQuery$,
  setChatListQuery$,
  swipeOpenThreadId$,
  setSwipeOpenThreadId$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { isMobileViewport$ } from "../../signals/zero-page/mobile-viewport.ts";
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
  const isMobile = useGet(isMobileViewport$);
  // The mobile redesign chrome is mobile-only — the chat list page on
  // desktop keeps the always-visible search bar and the regular new-chat
  // button. Resizing back to a desktop width restores the original UI.
  const mobileRedesign = mobileNativeOn && isMobile;

  // Mobile-native delegates search to the dedicated /search page, so the
  // term filter only applies on desktop / non-redesign mobile.
  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions =
    !mobileRedesign && trimmedTerm
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
        {!mobileRedesign && (
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
      {!mobileRedesign && (
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
          mobileRedesign ? "pt-2 pb-24" : "pb-4",
        )}
      >
        <ChatList
          loading={loading}
          error={error}
          sessions={filteredSessions}
          searchTerm={searchTerm}
          selectedRecentId={selectedRecentId}
          onRecentSelect={onRecentSelect}
          isMobile={mobileRedesign}
        />
      </div>

      {/* Floating action button — mobile-native only; sits above the bottom
          tab bar so the New chat entry stays accessible without occupying
          a full-width row. */}
      {mobileRedesign && (
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
  isMobile,
}: {
  loading: boolean;
  error: string | null;
  sessions: ChatThreadListItem[];
  searchTerm: string;
  selectedRecentId: string | null;
  onRecentSelect: (id: string) => void;
  isMobile: boolean;
}) {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const swipeOpenId = useGet(swipeOpenThreadId$);
  const setSwipeOpenId = useSet(setSwipeOpenThreadId$);
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
      <div className="flex flex-col">
        {sessions.map((session) => {
          return (
            <ChatListItem
              key={session.id}
              session={session}
              isSelected={selectedRecentId === session.id}
              isOpen={swipeOpenId === session.id}
              isMobile={isMobile}
              onOpen={setSwipeOpenId}
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

// Three-state icon for the chat list avatar slot. Precedence:
//   draft (unsent composer content) → pencil
//   running (active non-terminal run, typically a scheduled task) → calendar/clock
//   otherwise → chat bubble
// Style is consistent across all states: 40px gray-100 circle, gray-700 stroke.
function ThreadKindIcon({ session }: { session: ChatThreadListItem }) {
  const kind = session.hasDraft
    ? "draft"
    : session.running
      ? "schedule"
      : "chat";
  const Icon =
    kind === "draft"
      ? IconPencil
      : kind === "schedule"
        ? IconCalendarClock
        : IconMessageCircle;
  const label =
    kind === "draft"
      ? "Draft"
      : kind === "schedule"
        ? "Scheduled"
        : "Chat";
  return (
    <span
      aria-label={label}
      data-thread-kind={kind}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--gray-200))] ring-1 ring-border text-foreground/80"
    >
      <Icon size={18} stroke={1.6} />
    </span>
  );
}

function threadSecondaryLine(session: ChatThreadListItem): string {
  if (session.hasDraft) {
    return "Draft";
  }
  if (session.running) {
    return "Running…";
  }
  return "";
}

function ChatListItem({
  session,
  isSelected,
  isOpen,
  isMobile,
  onOpen,
  onSelect,
  onDelete,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  isOpen: boolean;
  isMobile: boolean;
  onOpen: (id: string | null) => void;
  onSelect: (id: string) => void;
  onDelete: () => void;
}) {
  const dateLabel = formatThreadDateLabel(
    session.updatedAt ?? session.createdAt,
    new Date(),
  );
  const isUnread = !session.isRead;
  // Mobile-native swipe-to-delete: track touch deltaX on the row and slide
  // the surface left to reveal a delete handle. Holds open until the user
  // taps the row, the delete, or starts another swipe.
  let touchStartX: number | null = null;
  const onTouchStart = (e: React.TouchEvent) => {
    if (!isMobile) {
      return;
    }
    touchStartX = e.touches[0]?.clientX ?? null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (!isMobile || touchStartX === null) {
      return;
    }
    const endX = e.changedTouches[0]?.clientX ?? touchStartX;
    const dx = endX - touchStartX;
    touchStartX = null;
    if (dx < -40) {
      onOpen(session.id);
    } else if (dx > 40 && isOpen) {
      onOpen(null);
    }
  };
  return (
    <div
      className="relative overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Swipe-revealed delete affordance — sits underneath the row. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen(null);
          onDelete();
        }}
        aria-label="Delete chat"
        data-testid={`chat-list-delete-${session.id}`}
        className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-muted text-foreground"
      >
        <IconTrash size={16} stroke={1.6} />
      </button>
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: session.id } }}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }
          if (isOpen) {
            e.preventDefault();
            onOpen(null);
            return;
          }
          e.preventDefault();
          onSelect(session.id);
        }}
        className={cn(
          "flex items-center gap-3 px-2 py-3 text-left transition-transform no-underline bg-background border-b border-border/40 last:border-b-0",
          isOpen ? "-translate-x-20" : "translate-x-0",
          isSelected
            ? "text-accent-foreground"
            : "text-foreground",
        )}
      >
        {/* Fixed-width gutter holds the unread dot so titles align across
            read and unread rows (iMessage-style). */}
        <span
          aria-hidden={!isUnread}
          aria-label={isUnread ? "Unread" : undefined}
          className="flex w-3 shrink-0 items-center justify-center"
        >
          {isUnread && (
            <span className="h-[7px] w-[7px] rounded-full bg-blue-500" />
          )}
        </span>
        <ThreadKindIcon session={session} />
        <span className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span
            className={cn(
              "truncate text-[15px] leading-snug",
              isUnread ? "font-semibold" : "font-medium",
            )}
          >
            {session.title ?? "New chat"}
          </span>
          {threadSecondaryLine(session) && (
            <span className="truncate text-xs text-muted-foreground">
              {threadSecondaryLine(session)}
            </span>
          )}
        </span>
        {dateLabel && (
          <span className="shrink-0 self-start mt-0.5 text-xs text-muted-foreground tabular-nums">
            {dateLabel}
          </span>
        )}
      </Link>
    </div>
  );
}
