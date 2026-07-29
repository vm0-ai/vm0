import type { MouseEvent } from "react";
import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import type { Computed } from "ccstate";
import {
  IconPlus,
  IconCheck,
  IconChevronRight,
  IconTrash,
  IconPencil,
  IconDots,
  IconPin,
  IconPinnedOff,
} from "@tabler/icons-react";
import { useChatThreadsTitleLabels } from "./zero-sidebar-shared.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
  Input,
  RunningIndicator,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
  deleteChatThread$,
  pinChatThread$,
  unpinChatThread$,
  renameChatThread$,
} from "../../signals/chat-page/chat-event.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import {
  SIDEBAR_PARAM,
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
  unloadRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import { focusChatThreadContainer$ } from "../../signals/chat-page/chat-keyboard.ts";
import {
  createNewChatThread$,
  newChatThreadDisabled$,
  type NewChatThreadPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  scrollToThread$,
  scrollCurrentChatThreadOnRef$,
  currentChatThreadListed$,
  type SidebarChatThread,
  sidebarChatThreadCount$,
  sidebarChatThreadWindow$,
  type SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import {
  currentChatAgentScope$,
  currentChatAgentId$,
  currentChatThreadId$,
} from "../../signals/agent-chat.ts";
import { sidebarActiveThreadIds$ } from "../../signals/chat-page/chat-thread-event-sourcing.ts";
import { pathParams$, searchParams$ } from "../../signals/route.ts";
import { setSidebarExpanded$ } from "../../signals/zero-page/zero-nav.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import { sidebarDraftThreadIds$ } from "../../signals/chat-page/sidebar-draft-threads.ts";
import { sidebarUnreadThreadIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../../signals/chat-page/chat-thread-only-unread.ts";
import {
  pendingDeleteThreadId$,
  renameDialogAgentId$,
  setPendingDeleteThreadId$,
  renameDialogThreadId$,
  renameDialogInput$,
  setRenameDialogAgentId$,
  setRenameDialogThreadId$,
  setRenameDialogInput$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
  isScrolled$,
  setIsScrolled$,
  setChatThreadVirtualListElement$,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { Link } from "../router/link.tsx";
import { OverlayScrollArea } from "./zero-sidebar-scroll.tsx";
import { equalArrays } from "../../lib/equality.ts";

type IndicatorState = "running" | "unread" | "draft";
type ChatThreadPaneIndicator = "main" | "sidebar";

function equalSidebarChatThreads(
  previous: SidebarChatThread,
  next: SidebarChatThread,
): boolean {
  return (
    previous.id === next.id &&
    previous.title === next.title &&
    previous.pinnedAt === next.pinnedAt
  );
}

function equalSidebarChatThreadWindows(
  previous: SidebarChatThreadWindow,
  next: SidebarChatThreadWindow,
): boolean {
  return (
    previous.startIndex === next.startIndex &&
    equalArrays(previous.chatThreads, next.chatThreads, equalSidebarChatThreads)
  );
}

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

// Deliberately no `equalityFn`: an inline one closes over `threadId`, so it gets
// a fresh identity every render. `useLastResolved` treats it as a subscription
// dependency, which makes every render resubscribe and re-report a settled
// rejection, spinning the row into an infinite render loop. The default
// referential check keeps the subscription stable; the cost is that all rows
// re-render when the set is refetched, which is cheap for a sidebar list.
function useThreadMembership(
  threadIds$: Computed<Promise<ReadonlySet<string>>>,
  threadId: string,
): boolean {
  const threadIds = useLastResolved(threadIds$);
  return threadIds?.has(threadId) ?? false;
}

function useThreadDraft(threadId: string): boolean {
  return useThreadMembership(sidebarDraftThreadIds$, threadId);
}

function useThreadUnread(threadId: string): boolean {
  return useThreadMembership(sidebarUnreadThreadIds$, threadId);
}

function useThreadActiveRun(threadId: string): boolean {
  return useThreadMembership(sidebarActiveThreadIds$, threadId);
}

function handleChatThreadClick(
  e: MouseEvent<HTMLAnchorElement>,
  {
    closeSidebarOnSelect,
    currentLeftId,
    currentRightId,
    loadLeftThread,
    loadRightThread,
    onChatPage,
    threadId,
    unloadRightThread,
  }: {
    closeSidebarOnSelect: () => void;
    currentLeftId: string | null;
    currentRightId: string | null;
    loadLeftThread: (threadId: string) => void;
    loadRightThread: (threadId: string) => void;
    onChatPage: boolean;
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
    // route system bootstraps the chat page from scratch. Still collapse the
    // mobile sidebar so the new page is visible after navigation.
    closeSidebarOnSelect();
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
      loadRightThread(threadId);
    }
  } else {
    // Plain click → drive the left pane.
    if (threadId === currentLeftId) {
      return;
    }
    loadLeftThread(threadId);
  }

  closeSidebarOnSelect();
}

function ChatThreadMenuTriggerContent({
  usePinnedIndicatorTrigger,
}: {
  usePinnedIndicatorTrigger: boolean;
}) {
  if (!usePinnedIndicatorTrigger) {
    return <IconDots size={16} stroke={2} />;
  }
  return (
    <>
      <IconPin size={16} stroke={2} className="md:hidden" />
      <IconDots size={16} stroke={2} className="hidden md:block" />
    </>
  );
}

function ChatThreadMenu({
  threadId,
  isPinned,
  isHighlighted,
  hasOtherIndicator,
  usePinnedIndicatorTrigger,
}: {
  threadId: string;
  isPinned: boolean;
  isHighlighted: boolean;
  hasOtherIndicator: boolean;
  usePinnedIndicatorTrigger: boolean;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const pinChatThread = useSet(pinChatThread$);
  const unpinChatThread = useSet(unpinChatThread$);
  const openRenameChatThreadDialog = useSet(
    openRenameChatThreadDialogForThreadId$,
  );
  const pageSignal = useGet(pageSignal$);

  function handleTogglePin() {
    if (isPinned) {
      detach(unpinChatThread(threadId, pageSignal), Reason.DomCallback);
    } else {
      detach(pinChatThread(threadId, pageSignal), Reason.DomCallback);
    }
  }

  function handleMenuTriggerClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function openRenameDialog() {
    detach(
      openRenameChatThreadDialog(threadId, pageSignal),
      Reason.DomCallback,
    );
  }

  const showMobileTrigger = !hasOtherIndicator || usePinnedIndicatorTrigger;

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={handleMenuTriggerClick}
            className={`peer pointer-events-auto absolute top-1 left-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md ${
              showMobileTrigger ? "visible" : "invisible"
            } md:invisible md:group-hover:visible md:data-[state=open]:visible transition-opacity duration-150 ${
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
                <span
                  aria-label={usePinnedIndicatorTrigger ? "Pinned" : undefined}
                  data-testid={
                    usePinnedIndicatorTrigger
                      ? "chat-thread-pinned-indicator"
                      : undefined
                  }
                >
                  <ChatThreadMenuTriggerContent
                    usePinnedIndicatorTrigger={usePinnedIndicatorTrigger}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">More</p>
              </TooltipContent>
            </Tooltip>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
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
          <DropdownMenuModalItem onModalSelect={openRenameDialog}>
            <IconPencil size={16} stroke={2} className="mr-2" />
            Rename chat
          </DropdownMenuModalItem>
          <DropdownMenuModalItem
            onModalSelect={() => {
              setPendingDeleteThreadId(threadId);
            }}
            className="text-destructive focus:text-destructive"
          >
            <IconTrash size={16} stroke={2} className="mr-2" />
            Delete chat
          </DropdownMenuModalItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadSideDecorator({
  threadId,
  isPinned,
  isHighlighted,
  indicatorState,
}: {
  threadId: string;
  isPinned: boolean;
  isHighlighted: boolean;
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
  const hasOtherIndicator = indicatorState !== null || isPinned;
  const usePinnedIndicatorTrigger = isPinned && indicatorState === null;
  return (
    <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
      <ChatThreadMenu
        threadId={threadId}
        isPinned={isPinned}
        isHighlighted={isHighlighted}
        hasOtherIndicator={hasOtherIndicator}
        usePinnedIndicatorTrigger={usePinnedIndicatorTrigger}
      />
      {indicatorState !== null ? (
        <span className="flex items-center justify-center group-hover:hidden peer-data-[state=open]:hidden">
          <SessionStateIndicator state={indicatorState} />
        </span>
      ) : isPinned ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label="Pinned"
                className="hidden items-center justify-center text-sidebar-foreground/70 group-hover:hidden peer-data-[state=open]:hidden md:flex"
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

function useChatThreadItemState(session: SidebarChatThread) {
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
  const hasDraft = useThreadDraft(session.id);
  const isThreadUnread = useThreadUnread(session.id);
  const hasActiveRun = useThreadActiveRun(session.id);

  const isPinned = session.pinnedAt !== null && session.pinnedAt !== undefined;
  const onChatPage = urlMainThreadId !== null;
  const isCurrentPage = urlMainThreadId === session.id;
  const isHighlighted = isCurrentPage || urlSidebarThreadId === session.id;
  const paneIndicator = getChatThreadPaneIndicator({
    isCurrentPage,
    sidebarThreadId: urlSidebarThreadId,
    threadId: session.id,
  });
  const isUnread = isThreadUnread && !isHighlighted;
  const indicatorState = getIndicatorState({
    hasDraft: hasDraft && !isHighlighted,
    isRunning: hasActiveRun,
    isUnread,
  });

  return {
    currentLeftId,
    currentRightId,
    isCurrentPage,
    isHighlighted,
    isPinned,
    isUnread,
    loadLeftThread,
    loadRightThread,
    onChatPage,
    pageSignal,
    paneIndicator,
    setSidebarExpanded,
    unloadRightThread,
    indicatorState,
  } as const;
}

function ChatThreadItemLink({
  session,
  state,
}: {
  session: SidebarChatThread;
  state: ReturnType<typeof useChatThreadItemState>;
}) {
  const openRenameChatThreadDialog = useSet(
    openRenameChatThreadDialogForThreadId$,
  );
  const closeSidebarOnSelect = () => {
    state.setSidebarExpanded(false);
  };

  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: session.id } }}
      aria-current={state.isCurrentPage ? "page" : undefined}
      data-sidebar-chat-thread-id={session.id}
      onClick={(e) => {
        handleChatThreadClick(e, {
          closeSidebarOnSelect,
          currentLeftId: state.currentLeftId,
          currentRightId: state.currentRightId,
          loadLeftThread: state.loadLeftThread,
          loadRightThread: state.loadRightThread,
          onChatPage: state.onChatPage,
          threadId: session.id,
          unloadRightThread: state.unloadRightThread,
        });
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        detach(
          openRenameChatThreadDialog(session.id, state.pageSignal),
          Reason.DomCallback,
        );
      }}
      className={`flex h-8 items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
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

function ChatThreadItem({ session }: { session: SidebarChatThread }) {
  const state = useChatThreadItemState(session);

  return (
    <div className="group relative">
      <ChatThreadItemLink session={session} state={state} />
      <ChatThreadSideDecorator
        threadId={session.id}
        isPinned={state.isPinned}
        isHighlighted={state.isHighlighted}
        indicatorState={state.indicatorState}
      />
    </div>
  );
}

function ChatThreadRenameDialog() {
  const renameDialogThreadId = useGet(renameDialogThreadId$);
  const renameDialogAgentId = useGet(renameDialogAgentId$);
  const renameDialogInput = useGet(renameDialogInput$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const setRenameDialogAgentId = useSet(setRenameDialogAgentId$);
  const setRenameDialogThreadId = useSet(setRenameDialogThreadId$);
  const renameChatThread = useSet(renameChatThread$);
  const focusChatThreadContainer = useSet(focusChatThreadContainer$);
  const pageSignal = useGet(pageSignal$);

  function closeRenameDialog() {
    const threadId = renameDialogThreadId;
    setRenameDialogThreadId(null);
    setRenameDialogAgentId(null);
    setRenameDialogInput("");
    if (threadId) {
      queueMicrotask(() => {
        focusChatThreadContainer(threadId);
      });
    }
  }

  function handleRename() {
    if (!renameDialogThreadId || !renameDialogInput.trim()) {
      return;
    }
    const threadId = renameDialogThreadId;
    const agentId = renameDialogAgentId;
    const title = renameDialogInput.trim();
    detach(
      (async () => {
        await renameChatThread({ threadId, title, agentId }, pageSignal);
      })(),
      Reason.DomCallback,
    );
    closeRenameDialog();
  }

  return (
    <Dialog
      open={renameDialogThreadId !== null}
      onOpenChange={(open) => {
        if (!open) {
          closeRenameDialog();
        }
      }}
    >
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (
            renameDialogThreadId &&
            focusChatThreadContainer(renameDialogThreadId)
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>
            Enter a new name for this chat thread.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleRename();
          }}
        >
          <div className="py-2">
            <Input
              type="text"
              autoFocus
              value={renameDialogInput}
              onChange={(e) => {
                return setRenameDialogInput(e.target.value);
              }}
              placeholder="Chat title"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                closeRenameDialog();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!renameDialogInput.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteChatThreadDialogContent({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Delete chat?</DialogTitle>
        <DialogDescription>
          This will permanently delete this chat. Any task currently running in
          this chat will be stopped immediately. This action cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          Delete
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function DeleteChatThreadDialog() {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const deleteChatThread = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(deleteChatThread(threadId, pageSignal), Reason.DomCallback);
  }

  function cancelDelete() {
    setPendingDeleteThreadId(null);
  }

  return (
    <Dialog
      open={pendingDeleteThreadId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setPendingDeleteThreadId(null);
        }
      }}
    >
      <DeleteChatThreadDialogContent
        onCancel={cancelDelete}
        onConfirm={confirmDelete}
      />
    </Dialog>
  );
}

function VirtualizedChatThreads({ threadCount }: { threadCount: number }) {
  const window = useLastResolved(sidebarChatThreadWindow$, {
    equalityFn: equalSidebarChatThreadWindows,
  });
  const setVirtualListElement = useSet(setChatThreadVirtualListElement$);
  const startIndex = window?.startIndex ?? 0;
  const visibleChatThreads = window?.chatThreads ?? [];

  return (
    <div
      ref={setVirtualListElement}
      className="relative w-full"
      data-testid="sidebar-chat-threads-virtual-list"
      style={{ height: threadCount * CHAT_THREAD_VIRTUAL_ROW_HEIGHT }}
    >
      {visibleChatThreads.map((session, visibleOffset) => {
        const index = startIndex + visibleOffset;
        return (
          <div
            key={session.id}
            data-index={index}
            data-testid="sidebar-chat-thread-virtual-row"
            className="absolute left-0 top-0 w-full pb-1"
            style={{
              transform: `translateY(${
                index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT
              }px)`,
            }}
          >
            <ChatThreadItem session={session} />
          </div>
        );
      })}
    </div>
  );
}

function ChatThreads({ threadCount }: { threadCount: number }) {
  const unreadOnly = useGet(chatThreadOnlyUnread$);

  if (threadCount === 0) {
    return (
      <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
        {unreadOnly
          ? "No unread chats"
          : "Start a conversation and it'll show up here"}
      </p>
    );
  }
  return <VirtualizedChatThreads threadCount={threadCount} />;
}

function ChatThreadsTitle() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const createNewChat = useSet(createNewChatThread$);
  const setExpanded = useSet(setSidebarExpanded$);
  const rootSignal = useGet(rootSignal$);
  const { titleLabel } = useChatThreadsTitleLabels();
  const newChatDisabled = useGet(newChatThreadDisabled$);
  const onNewChat = (pane: NewChatThreadPane) => {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
    setExpanded(false);
  };
  const setCollapsed = useSet(setSessionListCollapsed$);
  const collapsed = useGet(sessionListCollapsed$);
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const setUnreadOnly = useSet(setChatThreadOnlyUnread$);

  function toggleUnreadOnly(next: boolean) {
    setUnreadOnly(next);
    if (next) {
      setCollapsed(false);
    }
  }

  return (
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                }}
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-[hsl(var(--gray-200))] transition-colors"
                aria-label="Open chat list menu"
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
            <DropdownMenuContent
              align="end"
              className="w-44"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  onNewChat("main");
                }}
                disabled={!currentChatAgentId || newChatDisabled}
              >
                <IconPlus size={16} stroke={2} className="mr-2" />
                New chat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  toggleUnreadOnly(false);
                }}
              >
                <IconCheck
                  size={16}
                  stroke={2}
                  className={`mr-2 ${unreadOnly ? "invisible" : ""}`}
                />
                All chats
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  toggleUnreadOnly(true);
                }}
              >
                <IconCheck
                  size={16}
                  stroke={2}
                  className={`mr-2 ${unreadOnly ? "" : "invisible"}`}
                />
                Unread only
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

function markPointerFocus(viewport: HTMLElement) {
  const token = Math.random().toString(36);
  viewport.dataset.sidebarPointerFocusToken = token;
  viewport.ownerDocument.defaultView?.setTimeout(() => {
    if (viewport.dataset.sidebarPointerFocusToken !== token) {
      return;
    }

    delete viewport.dataset.sidebarPointerFocusToken;
  }, 350);
}

function consumePointerFocus(viewport: HTMLElement) {
  if (!viewport.dataset.sidebarPointerFocusToken) {
    return false;
  }

  delete viewport.dataset.sidebarPointerFocusToken;
  return true;
}

function ChatThreadsContent() {
  const collapsed = useGet(sessionListCollapsed$);

  if (collapsed) {
    return null;
  }

  return <ExpandedChatThreadsContent />;
}

function AgentChatThreadsContent({
  currentMainThreadId,
}: {
  currentMainThreadId: string | null;
}) {
  // The primitive count preserves the previous resolved value while the
  // underlying event projection recomputes. Visible rows subscribe separately
  // in VirtualizedChatThreads.
  const threadCountLoadable = useLastLoadable(sidebarChatThreadCount$);
  const threadCount =
    threadCountLoadable.state === "hasData" ? threadCountLoadable.data : 0;
  const chatThreadsLoading = threadCountLoadable.state === "loading";
  const currentMainThreadListed =
    useLastResolved(currentChatThreadListed$) ?? false;
  const scrollCurrentChatThreadOnRef = useSet(scrollCurrentChatThreadOnRef$);

  return (
    <div className="flex flex-col gap-1">
      {currentMainThreadId && currentMainThreadListed ? (
        <span
          key={currentMainThreadId}
          ref={scrollCurrentChatThreadOnRef}
          data-chat-thread-id={currentMainThreadId}
          hidden
        />
      ) : null}
      {chatThreadsLoading ? (
        <ChatThreadsSkeleton />
      ) : (
        <ChatThreads threadCount={threadCount} />
      )}
    </div>
  );
}

function ExpandedChatThreadsContent() {
  const agentScope = useGet(currentChatAgentScope$);
  const isScrolled = useGet(isScrolled$);
  const setIsScrolledFn = useSet(setIsScrolled$);
  const currentMainThreadId = useGet(currentChatThreadId$);
  const scrollToThread = useSet(scrollToThread$);
  const pageSignal = useGet(pageSignal$);
  const focusThreadLink = (
    viewport: HTMLElement,
    threadId: string,
  ): boolean => {
    const link = Array.from(
      viewport.querySelectorAll<HTMLAnchorElement>(
        "[data-sidebar-chat-thread-id]",
      ),
    ).find((candidate) => {
      return candidate.dataset.sidebarChatThreadId === threadId;
    });
    if (!link?.isConnected) {
      return false;
    }
    link.focus({ preventScroll: true });
    return true;
  };
  const focusThreadLinkOnNextFrame = (
    viewport: HTMLElement,
    threadId: string,
  ) => {
    const win = viewport.ownerDocument.defaultView;
    const focus = () => {
      focusThreadLink(viewport, threadId);
    };
    if (win?.requestAnimationFrame) {
      win.requestAnimationFrame(focus);
    } else {
      queueMicrotask(focus);
    }
  };
  const focusCurrentMainThreadLink = (viewport: HTMLElement) => {
    if (
      !currentMainThreadId ||
      focusThreadLink(viewport, currentMainThreadId)
    ) {
      return;
    }

    const scrollAndFocusCurrentThread = async () => {
      const scrolled = await scrollToThread(
        { threadId: currentMainThreadId, align: "top" },
        pageSignal,
      );
      if (scrolled) {
        focusThreadLinkOnNextFrame(viewport, currentMainThreadId);
      }
    };
    detach(scrollAndFocusCurrentThread(), Reason.DomCallback);
  };

  return (
    <OverlayScrollArea
      className="mt-1 min-h-0 flex-1"
      aria-label="Chat threads"
      data-testid="sidebar-scroll-area"
      tabIndex={currentMainThreadId ? 0 : undefined}
      onPointerDownCapture={(event) => {
        markPointerFocus(event.currentTarget);
      }}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (consumePointerFocus(event.currentTarget)) {
          return;
        }
        focusCurrentMainThreadLink(event.currentTarget);
      }}
      onScroll={(e) => {
        return setIsScrolledFn(e.currentTarget.scrollTop > 0);
      }}
      style={{
        boxShadow: isScrolled ? "0 -1px 0 0 hsl(var(--border) / 0.4)" : "none",
      }}
    >
      <AgentChatThreadsContent
        key={agentScope ?? "no-agent"}
        currentMainThreadId={currentMainThreadId}
      />
    </OverlayScrollArea>
  );
}
export function ChatThreadsSection() {
  const agentScope = useGet(currentChatAgentScope$);

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      <ChatThreadsTitle key={agentScope ?? "no-agent"} />
      <ChatThreadsContent />
      <ChatThreadRenameDialog />
      <DeleteChatThreadDialog />
    </div>
  );
}
