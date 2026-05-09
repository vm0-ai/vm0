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
  IconDots,
  IconPin,
  IconPinnedOff,
} from "@tabler/icons-react";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { useChatThreadsTitleLabels } from "./zero-sidebar-shared.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
  RunningIndicator,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
  pinChatThread$,
  unpinChatThread$,
  renameChatThread$,
} from "../../signals/chat-page/chat-message.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  SIDEBAR_PARAM,
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
  unloadRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  type OptimisticChatPane,
  sidebarChatThreads$,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import { pathParams$, searchParams$ } from "../../signals/route.ts";
import { setSidebarExpanded$ } from "../../signals/zero-page/zero-nav.ts";
import {
  threadSearchOpen$,
  sidebarSearchTerm$,
  setThreadSearchOpen$,
  setThreadSearchTerm$,
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  renameDialogThreadId$,
  renameDialogInput$,
  setRenameDialogThreadId$,
  setRenameDialogInput$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { Link } from "../router/link.tsx";

type IndicatorState = "running" | "unread" | "draft";
type ChatThreadPaneIndicator = "main" | "sidebar";

function SessionStateIndicator({ state }: { state: IndicatorState }) {
  if (state === "running") {
    return <RunningIndicator />;
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

function ChatThreadListPaneIcon({ pane }: { pane: ChatThreadPaneIndicator }) {
  return (
    <span
      aria-hidden="true"
      data-testid={`chat-thread-list-pane-icon-${pane}`}
      className="grid h-3 w-4 shrink-0 grid-cols-2 overflow-hidden rounded-[2px] border border-current"
    >
      <span className={pane === "main" ? "bg-current" : "bg-transparent"} />
      <span className={pane === "sidebar" ? "bg-current" : "bg-transparent"} />
    </span>
  );
}

function getChatThreadPaneIndicator({
  isCurrentPage,
  sidebarThreadId,
  threadId,
}: {
  isCurrentPage: boolean;
  sidebarThreadId: string | null;
  threadId: string;
}): ChatThreadPaneIndicator | null {
  if (!sidebarThreadId) {
    return null;
  }
  if (isCurrentPage) {
    return "main";
  }
  return sidebarThreadId === threadId ? "sidebar" : null;
}

function getIndicatorState({
  hasDraft,
  isRunning,
  isUnread,
}: {
  hasDraft: boolean;
  isRunning: boolean;
  isUnread: boolean;
}): IndicatorState | null {
  if (isRunning) {
    return "running";
  }
  if (isUnread) {
    return "unread";
  }
  return hasDraft ? "draft" : null;
}

function handleChatThreadClick(
  e: React.MouseEvent<HTMLAnchorElement>,
  {
    closeSidebarOnSelect,
    currentLeftId,
    currentRightId,
    loadLeftThread,
    loadRightThread,
    onChatPage,
    pageSignal,
    threadId,
    unloadRightThread,
  }: {
    closeSidebarOnSelect: () => void;
    currentLeftId: string | null;
    currentRightId: string | null;
    loadLeftThread: (threadId: string, signal: AbortSignal) => Promise<void>;
    loadRightThread: (threadId: string, signal: AbortSignal) => Promise<void>;
    onChatPage: boolean;
    pageSignal: AbortSignal;
    threadId: string;
    unloadRightThread: () => void;
  },
) {
  if (e.metaKey || e.ctrlKey || e.shiftKey) {
    // Modified click → let the browser handle it (open in new tab, etc.).
    return;
  }

  if (!onChatPage) {
    // Not on a chat thread page yet — let <Link> navigate normally so the
    // route system bootstraps the chat page from scratch.
    return;
  }

  e.preventDefault();

  if (e.altKey) {
    // Alt-click → drive the right (sidebar) pane.
    if (threadId === currentLeftId) {
      // Refuse to put the left thread into the right pane.
      return;
    }
    if (threadId === currentRightId) {
      // Same thread already in right → toggle close.
      unloadRightThread();
    } else {
      detach(
        loadRightThread(threadId, pageSignal),
        Reason.DomCallback,
        "loadRightThread",
      );
    }
  } else {
    // Plain click → drive the left pane.
    if (threadId === currentLeftId) {
      return;
    }
    detach(
      loadLeftThread(threadId, pageSignal),
      Reason.DomCallback,
      "loadLeftThread",
    );
  }

  closeSidebarOnSelect();
}

function ChatThreadDeleteButton({
  threadId,
  isHighlighted,
}: {
  threadId: string;
  isHighlighted: boolean;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);

  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteThreadId(threadId);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleDeleteClick}
            className={`pointer-events-auto absolute top-1 left-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
              isHighlighted
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
  );
}

function ChatThreadMenu({
  threadId,
  isPinned,
  isHighlighted,
  pinEnabled,
  renameEnabled,
}: {
  threadId: string;
  isPinned: boolean;
  isHighlighted: boolean;
  pinEnabled: boolean;
  renameEnabled: boolean;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const pinChatThread = useSet(pinChatThread$);
  const unpinChatThread = useSet(unpinChatThread$);
  const setRenameDialogThreadId = useSet(setRenameDialogThreadId$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const pageSignal = useGet(pageSignal$);

  function handleTogglePin() {
    if (isPinned) {
      detach(unpinChatThread(threadId, pageSignal), Reason.DomCallback);
    } else {
      detach(pinChatThread(threadId, pageSignal), Reason.DomCallback);
    }
  }

  function handleMenuTriggerClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function openRenameDialog() {
    setRenameDialogInput("");
    setRenameDialogThreadId(threadId);
  }

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={handleMenuTriggerClick}
            className={`peer pointer-events-auto absolute top-1 left-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md visible md:invisible md:group-hover:visible md:data-[state=open]:visible transition-opacity duration-150 ${
              isHighlighted
                ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
                : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
            }`}
            aria-label="Open chat menu"
            data-testid="chat-thread-menu-trigger"
            data-pinned={isPinned ? "true" : "false"}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <IconDots size={16} stroke={2} />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">More</p>
              </TooltipContent>
            </Tooltip>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {pinEnabled && (
            <DropdownMenuItem onSelect={handleTogglePin}>
              {isPinned ? (
                <>
                  <IconPinnedOff size={16} stroke={2} className="mr-2" />
                  Unpin chat
                </>
              ) : (
                <>
                  <IconPin size={16} stroke={2} className="mr-2" />
                  Pin chat
                </>
              )}
            </DropdownMenuItem>
          )}
          {renameEnabled && (
            <DropdownMenuItem onSelect={openRenameDialog}>
              <IconPencil size={16} stroke={2} className="mr-2" />
              Rename chat
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() => {
              setPendingDeleteThreadId(threadId);
            }}
            className="text-destructive focus:text-destructive"
          >
            <IconTrash size={16} stroke={2} className="mr-2" />
            Delete chat
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadSideDecorator({
  threadId,
  isPinned,
  isHighlighted,
  pinEnabled,
  renameEnabled,
  indicatorState,
}: {
  threadId: string;
  isPinned: boolean;
  isHighlighted: boolean;
  pinEnabled: boolean;
  renameEnabled: boolean;
  indicatorState: IndicatorState | null;
}) {
  if (indicatorState === "draft") {
    return (
      <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        <span className="flex items-center justify-center">
          <SessionStateIndicator state={indicatorState} />
        </span>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
      {pinEnabled || renameEnabled ? (
        <ChatThreadMenu
          threadId={threadId}
          isPinned={isPinned}
          isHighlighted={isHighlighted}
          pinEnabled={pinEnabled}
          renameEnabled={renameEnabled}
        />
      ) : (
        <ChatThreadDeleteButton
          threadId={threadId}
          isHighlighted={isHighlighted}
        />
      )}
      {indicatorState !== null ? (
        <span className="flex items-center justify-center group-hover:hidden peer-data-[state=open]:hidden">
          <SessionStateIndicator state={indicatorState} />
        </span>
      ) : pinEnabled && isPinned ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label="Pinned"
                data-testid="chat-thread-pinned-indicator"
                className="flex items-center justify-center text-sidebar-foreground/70 group-hover:hidden peer-data-[state=open]:hidden"
              >
                <IconPin size={16} stroke={2} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Pinned</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

function useChatThreadItemState(session: ChatThreadListItem) {
  const pathParams = useGet(pathParams$);
  const searchParams = useGet(searchParams$);
  const urlMainThreadId =
    typeof pathParams?.threadId === "string" ? pathParams.threadId : null;
  const sidebarParam = searchParams.get(SIDEBAR_PARAM);
  const urlSidebarThreadId =
    sidebarParam && sidebarParam !== urlMainThreadId ? sidebarParam : null;

  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const currentLeftId = leftThread?.threadId ?? null;
  const currentRightId = rightThread?.threadId ?? null;

  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const loadLeftThread = useSet(loadLeftThread$);
  const loadRightThread = useSet(loadRightThread$);
  const unloadRightThread = useSet(unloadRightThread$);
  const pageSignal = useGet(pageSignal$);
  const features = useLastResolved(featureSwitch$);
  const pinEnabled = features?.[FeatureSwitchKey.ChatThreadPin] ?? false;
  const renameEnabled = features?.[FeatureSwitchKey.ChatThreadRename] ?? false;

  const isPinned =
    pinEnabled && session.pinnedAt !== null && session.pinnedAt !== undefined;
  const onChatPage = urlMainThreadId !== null;
  const isCurrentPage = urlMainThreadId === session.id;
  const isHighlighted = isCurrentPage || urlSidebarThreadId === session.id;
  const paneIndicator = getChatThreadPaneIndicator({
    isCurrentPage,
    sidebarThreadId: urlSidebarThreadId,
    threadId: session.id,
  });
  const indicatorState = getIndicatorState({
    hasDraft: (session.hasDraft ?? false) && !isHighlighted,
    isRunning: session.running,
    isUnread: !session.isRead && !isHighlighted,
  });

  return {
    currentLeftId,
    currentRightId,
    isCurrentPage,
    isHighlighted,
    isPinned,
    isUnread: !session.isRead && !isHighlighted,
    loadLeftThread,
    loadRightThread,
    onChatPage,
    pageSignal,
    paneIndicator,
    pinEnabled,
    renameEnabled,
    setSidebarExpanded,
    unloadRightThread,
    indicatorState,
  } as const;
}

function ChatThreadItemLink({
  session,
  state,
}: {
  session: ChatThreadListItem;
  state: ReturnType<typeof useChatThreadItemState>;
}) {
  const closeSidebarOnSelect = () => {
    state.setSidebarExpanded(false);
  };

  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: session.id } }}
      aria-current={state.isCurrentPage ? "page" : undefined}
      data-chat-thread-id={session.id}
      onClick={(e) => {
        handleChatThreadClick(e, {
          closeSidebarOnSelect,
          currentLeftId: state.currentLeftId,
          currentRightId: state.currentRightId,
          loadLeftThread: state.loadLeftThread,
          loadRightThread: state.loadRightThread,
          onChatPage: state.onChatPage,
          pageSignal: state.pageSignal,
          threadId: session.id,
          unloadRightThread: state.unloadRightThread,
        });
      }}
      className={`flex h-8 items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-left text-sm leading-5 transition-colors ${
        state.isHighlighted
          ? "bg-gray-200 text-gray-900 font-medium"
          : state.isUnread
            ? "text-sidebar-foreground font-medium hover:bg-sidebar-accent"
            : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {state.paneIndicator && (
          <ChatThreadListPaneIcon pane={state.paneIndicator} />
        )}
        <span className="min-w-0 truncate">{session.title ?? "New chat"}</span>
      </span>
    </Link>
  );
}

function ChatThreadItem({ session }: { session: ChatThreadListItem }) {
  const state = useChatThreadItemState(session);

  return (
    <div className="group relative">
      <ChatThreadItemLink session={session} state={state} />
      <ChatThreadSideDecorator
        threadId={session.id}
        isPinned={state.isPinned}
        isHighlighted={state.isHighlighted}
        pinEnabled={state.pinEnabled}
        renameEnabled={state.renameEnabled}
        indicatorState={state.indicatorState}
      />
    </div>
  );
}

function ChatThreadRenameDialog() {
  const renameDialogThreadId = useGet(renameDialogThreadId$);
  const renameDialogInput = useGet(renameDialogInput$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const setRenameDialogThreadId = useSet(setRenameDialogThreadId$);
  const renameChatThread = useSet(renameChatThread$);
  const pageSignal = useGet(pageSignal$);

  function handleRename() {
    if (!renameDialogThreadId || !renameDialogInput.trim()) {
      return;
    }
    detach(
      renameChatThread(
        { threadId: renameDialogThreadId, title: renameDialogInput.trim() },
        pageSignal,
      ),
      Reason.DomCallback,
    );
    setRenameDialogThreadId(null);
    setRenameDialogInput("");
  }

  return (
    <Dialog
      open={renameDialogThreadId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setRenameDialogThreadId(null);
          setRenameDialogInput("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>
            Enter a new name for this chat thread.
          </DialogDescription>
        </DialogHeader>
        <div className="py-2">
          <input
            type="text"
            autoFocus
            value={renameDialogInput}
            onChange={(e) => {
              return setRenameDialogInput(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleRename();
              }
            }}
            placeholder="Chat title"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setRenameDialogThreadId(null);
              setRenameDialogInput("");
            }}
          >
            Cancel
          </Button>
          <Button disabled={!renameDialogInput.trim()} onClick={handleRename}>
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChatThreads() {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const deleteChatThread = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  const chatThreads = useLastResolved(sidebarChatThreads$) ?? [];
  const searchTerm = useGet(sidebarSearchTerm$);
  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredChatThreads = trimmedTerm
    ? chatThreads.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : chatThreads;

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(deleteChatThread(threadId, pageSignal), Reason.DomCallback);
  }

  if (filteredChatThreads.length === 0) {
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
      {filteredChatThreads.map((session) => {
        return <ChatThreadItem key={session.id} session={session} />;
      })}
      <ChatThreadRenameDialog />
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
  const rootSignal = useGet(rootSignal$);
  const { titleLabel, searchPlaceholder, newChatAriaLabel } =
    useChatThreadsTitleLabels();
  const newChatDisabled = useGet(optimisticChatThread$) !== null;
  const onNewChat = (pane: OptimisticChatPane) => {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
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
                  onNewChat(e.altKey ? "sidebar" : "main");
                }}
                disabled={!currentChatAgentId || newChatDisabled}
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
