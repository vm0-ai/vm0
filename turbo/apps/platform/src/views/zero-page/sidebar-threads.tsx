import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import {
  IconSearch,
  IconX,
  IconPlus,
  IconChevronRight,
  IconTrash,
  IconPencil,
  IconLoader2,
} from "@tabler/icons-react";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import { useChatThreadsTitleLabels } from "./zero-sidebar-shared.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
} from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  chatThreads$,
  deleteChatThread$,
} from "../../signals/chat-page/chat-message.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  pendingOptimisticChatThreads$,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { pathParams$ } from "../../signals/route.ts";
import { setSidebarExpanded$ } from "../../signals/zero-page/zero-nav.ts";
import {
  threadSearchOpen$,
  sidebarSearchTerm$,
  setThreadSearchOpen$,
  setThreadSearchTerm$,
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { Link } from "../router/link.tsx";

type IndicatorState = "running" | "unread" | "draft";

function SessionStateIndicator({ state }: { state: IndicatorState }) {
  if (state === "running") {
    return (
      <IconLoader2
        aria-label="Running"
        size={16}
        stroke={2}
        className="animate-spin text-sky-600"
      />
    );
  }
  if (state === "unread") {
    return (
      <span aria-label="Unread" className="h-2 w-2 rounded-full bg-sky-600" />
    );
  }
  return (
    <span
      aria-label="Draft"
      className="flex items-center justify-center text-sidebar-foreground/50"
    >
      <IconPencil size={16} stroke={2} />
    </span>
  );
}

function ChatThreadItem({
  session,
  isSelected,
  onSelect,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  onSelect?: () => void;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const isRunning = session.running;
  const isUnread = !session.isRead && !isSelected;
  const hasDraft = (session.hasDraft ?? false) && !isSelected;

  // Priority: running > unread > draft. Only one indicator occupies the
  // right slot at a time; on hover the slot swaps to the delete button.
  const indicatorState: IndicatorState | null = isRunning
    ? "running"
    : isUnread
      ? "unread"
      : hasDraft
        ? "draft"
        : null;

  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteThreadId(session.id);
  }

  return (
    <div className="group relative">
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: session.id } }}
        aria-current={isSelected ? "page" : undefined}
        data-chat-thread-id={session.id}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }
          onSelect?.();
        }}
        className={`flex h-8 items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-left text-sm leading-5 transition-colors ${
          isSelected
            ? "bg-gray-200 text-gray-900 font-medium"
            : isUnread
              ? "text-sidebar-foreground font-medium hover:bg-sidebar-accent"
              : "text-sidebar-foreground hover:bg-sidebar-accent"
        }`}
      >
        <span className="truncate min-w-0 flex-1">
          {session.title ?? "New chat"}
        </span>
      </Link>
      <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        {indicatorState !== null && (
          <span
            className={`flex items-center justify-center ${
              indicatorState === "draft" ? "" : "group-hover:invisible"
            }`}
          >
            <SessionStateIndicator state={indicatorState} />
          </span>
        )}
        {indicatorState !== "draft" && (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  className={`pointer-events-auto absolute top-1 left-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                    isSelected
                      ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
                      : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
                  }`}
                  aria-label="Delete chat"
                >
                  <IconTrash size={16} stroke={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">Delete chat</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function ChatThreads() {
  const pathParams = useGet(pathParams$);
  const selectedThreadId =
    typeof pathParams?.threadId === "string" ? pathParams.threadId : null;
  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const deleteChatThread = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  const chatThreads = useLastResolved(chatThreads$) ?? [];
  const optimisticChatThreads =
    useLastResolved(pendingOptimisticChatThreads$) ?? [];
  const searchTerm = useGet(sidebarSearchTerm$);
  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredChatThreads = trimmedTerm
    ? chatThreads.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : chatThreads;
  const filteredOptimisticChatThreads = trimmedTerm
    ? optimisticChatThreads.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : optimisticChatThreads;

  const onRecentSelect = () => {
    setSidebarExpanded(false);
  };

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(deleteChatThread(threadId, pageSignal), Reason.DomCallback);
  }

  if (
    filteredOptimisticChatThreads.length === 0 &&
    filteredChatThreads.length === 0
  ) {
    return (
      <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
        {trimmedTerm
          ? "No chats match your search"
          : "Start a conversation and it'll show up here"}
      </p>
    );
  }
  return (
    <>
      {filteredOptimisticChatThreads.map((session) => {
        return (
          <ChatThreadItem
            key={session.id}
            session={session}
            isSelected={selectedThreadId === session.id}
            onSelect={onRecentSelect}
          />
        );
      })}
      {filteredChatThreads.map((session) => {
        return (
          <ChatThreadItem
            key={session.id}
            session={session}
            isSelected={selectedThreadId === session.id}
            onSelect={onRecentSelect}
          />
        );
      })}
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
                setPendingDeleteThreadId(null);
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

function ChatThreadsTitle() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const setExpanded = useSet(setSidebarExpanded$);
  const { signal: rootSignal } = useGet(rootSignal$);
  const { titleLabel, searchPlaceholder, newChatAriaLabel } =
    useChatThreadsTitleLabels();
  const newChatDisabled = useGet(optimisticChatThread$) !== null;
  const onNewChat = () => {
    detach(createNewChat(currentChatAgentId, rootSignal), Reason.DomCallback);
    setExpanded(false);
  };
  const searchOpen = useGet(threadSearchOpen$);
  const setSearchOpen = useSet(setThreadSearchOpen$);
  const searchTerm = useGet(sidebarSearchTerm$);
  const setSearchTerm = useSet(setThreadSearchTerm$);
  const setCollapsed = useSet(setSessionListCollapsed$);
  const collapsed = useGet(sessionListCollapsed$);

  return searchOpen ? (
    <div className="shrink-0 flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/60 pl-2 pr-2 zero-border">
      <IconSearch
        size={15}
        stroke={2.5}
        className="shrink-0 text-sidebar-foreground/50"
      />
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => {
          return setSearchTerm(e.target.value);
        }}
        placeholder={searchPlaceholder}
        autoFocus
        className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
      />
      <div className="flex h-8 w-8 shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            setSearchOpen(false);
          }}
          className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
          aria-label="Close search"
        >
          <IconX size={12} stroke={2} />
        </button>
      </div>
    </div>
  ) : (
    <div
      className="zero-nav-recent-label group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent transition-colors"
      onClick={() => {
        return setCollapsed(!collapsed);
      }}
    >
      <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
        {titleLabel}
        <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <IconChevronRight
            size={12}
            stroke={2}
            className={collapsed ? "" : "rotate-90"}
          />
        </span>
      </span>
      <div className="flex items-center gap-0.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setSearchOpen(true);
                }}
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-[hsl(var(--gray-200))] transition-colors"
                aria-label="Search chats"
              >
                <IconSearch size={15} stroke={2.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Search chats</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewChat();
                }}
                disabled={newChatDisabled}
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-[hsl(var(--gray-200))] transition-colors disabled:opacity-50"
                aria-label={newChatAriaLabel}
              >
                <IconPlus size={15} stroke={2.5} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">New chat</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ChatThreadsSkeleton() {
  return (
    <>
      {["w-3/4", "w-1/2", "w-2/3"].map((w) => {
        return (
          <div
            key={w}
            data-testid="sidebar-skeleton"
            className="flex h-8 items-center rounded-lg p-2"
          >
            <Skeleton className={`h-4 ${w}`} />
          </div>
        );
      })}
    </>
  );
}

function ChatThreadsContent() {
  const chatThreadsLoading = useLastLoadable(chatThreads$).state === "loading";

  const collapsed = useGet(sessionListCollapsed$);

  return (
    !collapsed && (
      <div className="mt-1">
        <div className="flex flex-col gap-1">
          {chatThreadsLoading ? <ChatThreadsSkeleton /> : <ChatThreads />}
        </div>
      </div>
    )
  );
}
export function ChatThreadsSection() {
  return (
    <div className="mt-4 flex flex-col">
      <ChatThreadsTitle />
      <ChatThreadsContent />
    </div>
  );
}
