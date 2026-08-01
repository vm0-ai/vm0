import type { MouseEvent } from "react";
import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
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
  renameChatThread$,
} from "../../signals/chat-page/chat-event.ts";
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
  sidebarChatThreadCount$,
  sidebarChatThreadWindow$,
  type SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import {
  currentChatAgentScope$,
  currentChatAgentId$,
  currentChatThreadId$,
} from "../../signals/agent-chat.ts";
import { setSidebarExpanded$ } from "../../signals/zero-page/zero-nav.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
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

function equalSidebarChatThreadWindows(
  previous: SidebarChatThreadWindow,
  next: SidebarChatThreadWindow,
): boolean {
  return (
    previous.startIndex === next.startIndex &&
    equalArrays(previous.items, next.items, (left, right) => {
      return left === right;
    })
  );
}

function SessionStateIndicator({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const state = useLastResolved(signals.indicatorState$) ?? null;
  if (state === null) {
    return null;
  }
  if (state === "running") {
    return <RunningIndicator />;
  }
  if (state === "unread") {
    return (
      <span
        aria-label={t(($) => {
          return $.chat.sidebar.unread;
        })}
        className="h-2 w-2 rounded-full bg-sky-600"
      />
    );
  }
  return (
    <span
      aria-label={t(($) => {
        return $.chat.sidebar.draft;
      })}
      className="flex items-center justify-center text-sidebar-foreground/50"
    >
      <IconPencil size={16} stroke={2} />
    </span>
  );
}

function ChatThreadListPaneIcon({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const pane = useGet(signals.paneIndicator$);
  if (pane === null) {
    return null;
  }
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

function preventChatThreadMenuNavigation(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function ChatThreadMenu({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const isHighlighted = useGet(signals.highlighted$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  const togglePinned = useSet(signals.togglePinned$);
  const openRename = useSet(signals.openRename$);
  const requestDelete = useSet(signals.requestDelete$);
  const pageSignal = useGet(pageSignal$);

  function handleTogglePin() {
    detach(togglePinned(pageSignal), Reason.DomCallback);
  }

  function openRenameDialog() {
    detach(openRename(pageSignal), Reason.DomCallback);
  }

  const hasOtherIndicator = indicatorState !== null || isPinned;
  const usePinnedIndicatorTrigger = isPinned && indicatorState === null;
  const showMobileTrigger = !hasOtherIndicator || usePinnedIndicatorTrigger;

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={preventChatThreadMenuNavigation}
            className={`peer pointer-events-auto absolute top-1 left-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md ${
              showMobileTrigger ? "visible" : "invisible"
            } md:invisible md:group-hover:visible md:data-[state=open]:visible transition-opacity duration-150 ${
              isHighlighted
                ? "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-300))]"
                : "text-sidebar-foreground/80 hover:text-foreground hover:bg-[hsl(var(--gray-200))]"
            }`}
            aria-label={t(($) => {
              return $.chat.sidebar.openChatMenu;
            })}
            data-testid="chat-thread-menu-trigger"
            data-pinned={isPinned ? "true" : "false"}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  aria-label={
                    usePinnedIndicatorTrigger
                      ? t(($) => {
                          return $.chat.sidebar.pinned;
                        })
                      : undefined
                  }
                  data-testid={
                    usePinnedIndicatorTrigger
                      ? "chat-thread-pinned-indicator"
                      : undefined
                  }
                >
                  {usePinnedIndicatorTrigger ? (
                    <>
                      <IconPin size={16} stroke={2} className="md:hidden" />
                      <IconDots
                        size={16}
                        stroke={2}
                        className="hidden md:block"
                      />
                    </>
                  ) : (
                    <IconDots size={16} stroke={2} />
                  )}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {t(($) => {
                    return $.chat.actions.more;
                  })}
                </p>
              </TooltipContent>
            </Tooltip>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={handleTogglePin}>
            {isPinned ? (
              <>
                <IconPinnedOff size={16} stroke={2} className="mr-2" />
                {t(($) => {
                  return $.chat.sidebar.unpin;
                })}
              </>
            ) : (
              <>
                <IconPin size={16} stroke={2} className="mr-2" />
                {t(($) => {
                  return $.chat.sidebar.pin;
                })}
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuModalItem onModalSelect={openRenameDialog}>
            <IconPencil size={16} stroke={2} className="mr-2" />
            {t(($) => {
              return $.chat.sidebar.rename;
            })}
          </DropdownMenuModalItem>
          <DropdownMenuModalItem
            onModalSelect={() => {
              requestDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <IconTrash size={16} stroke={2} className="mr-2" />
            {t(($) => {
              return $.chat.sidebar.delete;
            })}
          </DropdownMenuModalItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadSideDecorator({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
  const indicatorState = useLastResolved(signals.indicatorState$) ?? null;
  if (indicatorState === "draft") {
    return (
      <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        <span className="flex items-center justify-center">
          <SessionStateIndicator signals={signals} />
        </span>
      </div>
    );
  }
  return (
    <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
      <ChatThreadMenu signals={signals} />
      {indicatorState !== null ? (
        <span className="flex items-center justify-center group-hover:hidden peer-data-[state=open]:hidden">
          <SessionStateIndicator signals={signals} />
        </span>
      ) : isPinned ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-label={t(($) => {
                  return $.chat.sidebar.pinned;
                })}
                className="hidden items-center justify-center text-sidebar-foreground/70 group-hover:hidden peer-data-[state=open]:hidden md:flex"
              >
                <IconPin size={16} stroke={2} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {t(($) => {
                  return $.chat.sidebar.pinned;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </div>
  );
}

function ChatThreadItemLink({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const title = useGet(signals.title$);
  const isCurrentPage = useGet(signals.currentPage$);
  const isHighlighted = useGet(signals.highlighted$);
  const isUnread = useLastResolved(signals.unread$) ?? false;
  const select = useSet(signals.select$);
  const openRename = useSet(signals.openRename$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Link
      pathname="/chats/:threadId"
      options={{ pathParams: { threadId: signals.threadId } }}
      aria-current={isCurrentPage ? "page" : undefined}
      data-sidebar-chat-thread-id={signals.threadId}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          return;
        }
        if (select(e.altKey ? "sidebar" : "main")) {
          e.preventDefault();
        }
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        detach(openRename(pageSignal), Reason.DomCallback);
      }}
      className={`flex h-8 items-center gap-2 rounded-lg py-2 pl-2 pr-8 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        isHighlighted
          ? "bg-gray-200 text-gray-900 font-medium"
          : isUnread
            ? "text-sidebar-foreground font-medium hover:bg-sidebar-accent"
            : "text-sidebar-foreground hover:bg-sidebar-accent"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <ChatThreadListPaneIcon signals={signals} />
        <span className="min-w-0 truncate">
          {title ??
            t(($) => {
              return $.chat.newChat;
            })}
        </span>
      </span>
    </Link>
  );
}

function ChatThreadItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  return (
    <div className="group relative">
      <ChatThreadItemLink signals={signals} />
      <ChatThreadSideDecorator signals={signals} />
    </div>
  );
}

function ChatThreadRenameDialog() {
  const { t } = useTranslation();
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
          <DialogTitle>
            {t(($) => {
              return $.chat.sidebar.rename;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.sidebar.renameDescription;
            })}
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
              placeholder={t(($) => {
                return $.chat.sidebar.titlePlaceholder;
              })}
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
              {t(($) => {
                return $.chat.actions.cancel;
              })}
            </Button>
            <Button type="submit" disabled={!renameDialogInput.trim()}>
              {t(($) => {
                return $.chat.actions.rename;
              })}
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
  const { t } = useTranslation();
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>
          {t(($) => {
            return $.chat.sidebar.deleteTitle;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.chat.sidebar.deleteDescription;
          })}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {t(($) => {
            return $.chat.actions.delete;
          })}
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
  const visibleItems = window?.items ?? [];

  return (
    <div
      ref={setVirtualListElement}
      className="relative w-full"
      data-testid="sidebar-chat-threads-virtual-list"
      style={{ height: threadCount * CHAT_THREAD_VIRTUAL_ROW_HEIGHT }}
    >
      {visibleItems.map((signals, visibleOffset) => {
        const index = startIndex + visibleOffset;
        return (
          <div
            key={signals.threadId}
            data-index={index}
            data-testid="sidebar-chat-thread-virtual-row"
            className="absolute left-0 top-0 w-full pb-1"
            style={{
              transform: `translateY(${
                index * CHAT_THREAD_VIRTUAL_ROW_HEIGHT
              }px)`,
            }}
          >
            <ChatThreadItem signals={signals} />
          </div>
        );
      })}
    </div>
  );
}

function ChatThreads({ threadCount }: { threadCount: number }) {
  const { t } = useTranslation();
  const unreadOnly = useGet(chatThreadOnlyUnread$);

  if (threadCount === 0) {
    return (
      <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
        {unreadOnly
          ? t(($) => {
              return $.chat.sidebar.noUnread;
            })
          : t(($) => {
              return $.chat.sidebar.empty;
            })}
      </p>
    );
  }
  return <VirtualizedChatThreads threadCount={threadCount} />;
}

function ChatThreadsListMenuTooltip() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <IconDots size={16} stroke={2} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p className="text-xs">
          {t(($) => {
            return $.chat.actions.more;
          })}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function ChatThreadsTitle() {
  const { t } = useTranslation();
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
                aria-label={t(($) => {
                  return $.chat.sidebar.openListMenu;
                })}
              >
                <ChatThreadsListMenuTooltip />
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
                {t(($) => {
                  return $.chat.newChat;
                })}
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
                {t(($) => {
                  return $.chat.sidebar.allChats;
                })}
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
                {t(($) => {
                  return $.chat.sidebar.unreadOnly;
                })}
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
  const { t } = useTranslation();
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
      aria-label={t(($) => {
        return $.chat.sidebar.chatThreads;
      })}
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
