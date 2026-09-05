import type { MouseEvent } from "react";
import { timeout } from "signal-timers";
import {
  useGet,
  useSet,
  useLastResolved,
  useLastLoadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Check,
  CheckCheck,
  ChevronRight,
  Trash,
  Pencil,
  Ellipsis,
  MessageSquareDot,
  Pin,
  PinOff,
} from "lucide-react";
import { useChatThreadsTitleLabels } from "./sidebar-shared.tsx";
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
} from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@okouai/ui/components/ui/dialog";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { mainStylesheetLoaded$ } from "../../signals/app-skeleton.ts";
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
  currentChatThreadListed$,
  sidebarChatThreadCount$,
  type SidebarChatThreadScrollSignals,
  type SidebarChatThreadWindow,
} from "../../signals/chat-page/sidebar-chat-thread-scroll.ts";
import type { SidebarChatThreadItemSignals } from "../../signals/chat-page/sidebar-chat-thread-item.ts";
import {
  currentChatAgentScope$,
  currentChatAgentId$,
  currentChatThreadId$,
} from "../../signals/agent-chat.ts";
import { setSidebarExpanded$ } from "../../signals/okou-page/nav.ts";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
import {
  chatThreadOnlyUnread$,
  setChatThreadOnlyUnread$,
} from "../../signals/chat-page/chat-thread-only-unread.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/chat-thread-indicators-from-worker.ts";
import { markAgentThreadsRead$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  closeRenameChatThreadDialog$,
  pendingDeleteThreadId$,
  renameDialogAgentId$,
  renameDialogOpen$,
  setPendingDeleteThreadId$,
  renameDialogThreadId$,
  renameDialogInput$,
  setRenameDialogInput$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  threeColumnSearchOpen$,
} from "../../signals/okou-page/sidebar-state.ts";
import { setThreadListNumberShortcutRoot$ } from "../../signals/okou-page/thread-list-number-shortcuts.ts";
import { ThreadNumberShortcutHint } from "./thread-number-shortcut-hint.tsx";
import { Link } from "../router/link.tsx";
import { OverlayScrollArea } from "./sidebar-scroll.tsx";
import { equalArrays } from "../../lib/equality.ts";

// The row glyphs draw at 17px, which the shared button base (`[&_svg]:size-4`)
// would otherwise clamp to 16px. Dimming stays on the individual glyphs so the
// state indicators keep their own contrast.
const CHAT_THREAD_ROW_ICON_CLASS = "[&_svg]:size-[17px]";

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
        role="img"
        aria-label={t(($) => {
          return $.chat.sidebar.unread;
        })}
        className="h-2 w-2 rounded-full bg-sky-600"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={t(($) => {
        return $.chat.sidebar.draft;
      })}
      className="flex items-center justify-center text-sidebar-foreground"
    >
      <Pencil className="opacity-35" size={16} />
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

function ChatThreadMarkUnreadMenuItem({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const markUnread = useSet(signals.markUnread$);
  const pageSignal = useGet(pageSignal$);

  return (
    <DropdownMenuItem
      onSelect={() => {
        detach(markUnread(pageSignal), Reason.DomCallback);
      }}
    >
      <MessageSquareDot size={16} className="mr-2" />
      {t(($) => {
        return $.chat.sidebar.markUnread;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadMenu({
  signals,
}: {
  signals: SidebarChatThreadItemSignals;
}) {
  const { t } = useTranslation();
  const isPinned = useGet(signals.pinned$);
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

  const showStateIndicator = indicatorState !== null;
  const showPinIndicator = isPinned && indicatorState === null;
  const hasRestingIndicator = showStateIndicator || showPinIndicator;

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            onClick={preventChatThreadMenuNavigation}
            variant="quiet"
            size="icon-2xs"
            className={`group/thread-menu pointer-events-auto absolute left-1 top-1 cursor-pointer rounded-md transition-opacity duration-150 ${
              hasRestingIndicator
                ? ""
                : "md:invisible md:group-hover:visible md:data-popup-open:visible"
            } ${CHAT_THREAD_ROW_ICON_CLASS}`}
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
                    showPinIndicator
                      ? t(($) => {
                          return $.chat.sidebar.pinned;
                        })
                      : undefined
                  }
                  data-testid={
                    showPinIndicator
                      ? "chat-thread-pinned-indicator"
                      : undefined
                  }
                  className="flex items-center justify-center"
                >
                  {hasRestingIndicator ? (
                    <>
                      <span className="flex items-center justify-center md:group-hover:hidden md:group-data-[popup-open]/thread-menu:hidden">
                        {showStateIndicator ? (
                          <SessionStateIndicator signals={signals} />
                        ) : (
                          <Pin size={17} className="opacity-70" />
                        )}
                      </span>
                      <Ellipsis
                        size={17}
                        className="hidden opacity-70 md:group-hover:block md:group-data-[popup-open]/thread-menu:block"
                      />
                    </>
                  ) : (
                    <Ellipsis size={17} className="opacity-70" />
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
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onSelect={handleTogglePin}>
            {isPinned ? (
              <>
                <PinOff size={16} className="mr-2" />
                {t(($) => {
                  return $.chat.sidebar.unpin;
                })}
              </>
            ) : (
              <>
                <Pin size={16} className="mr-2" />
                {t(($) => {
                  return $.chat.sidebar.pin;
                })}
              </>
            )}
          </DropdownMenuItem>
          <ChatThreadMarkUnreadMenuItem signals={signals} />
          <DropdownMenuModalItem onModalSelect={openRenameDialog}>
            <Pencil size={16} className="mr-2" />
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
            <Trash size={16} className="mr-2" />
            {t(($) => {
              return $.chat.sidebar.delete;
            })}
          </DropdownMenuModalItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadItemLink({
  signals,
  shortcutNumber,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
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
          ? "bg-state-selected text-sidebar-foreground font-medium"
          : isUnread
            ? "text-sidebar-foreground font-medium hover:bg-state-hover"
            : "text-sidebar-foreground hover:bg-state-hover"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <ChatThreadListPaneIcon signals={signals} />
        <span className="okou-nav-copy min-w-0 truncate">
          {title ??
            t(($) => {
              return $.chat.newChat;
            })}
        </span>
      </span>
      <ThreadNumberShortcutHint shortcutNumber={shortcutNumber} />
    </Link>
  );
}

function ChatThreadItem({
  signals,
  shortcutNumber,
}: {
  signals: SidebarChatThreadItemSignals;
  shortcutNumber: number | undefined;
}) {
  return (
    <div className="group relative">
      <ChatThreadItemLink signals={signals} shortcutNumber={shortcutNumber} />
      <div className="pointer-events-none absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        <ChatThreadMenu signals={signals} />
      </div>
    </div>
  );
}

function ChatThreadRenameDialog() {
  const { t } = useTranslation();
  const renameDialogOpen = useGet(renameDialogOpen$);
  const renameDialogThreadId = useGet(renameDialogThreadId$);
  const renameDialogAgentId = useGet(renameDialogAgentId$);
  const renameDialogInput = useGet(renameDialogInput$);
  const closeRenameChatThreadDialog = useSet(closeRenameChatThreadDialog$);
  const setRenameDialogInput = useSet(setRenameDialogInput$);
  const renameChatThread = useSet(renameChatThread$);
  const focusChatThreadContainer = useSet(focusChatThreadContainer$);
  const pageSignal = useGet(pageSignal$);

  function closeRenameDialog() {
    const threadId = renameDialogThreadId;
    closeRenameChatThreadDialog();
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
      open={renameDialogOpen}
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

export function ChatThreadDialogs() {
  return (
    <>
      <ChatThreadRenameDialog />
      <DeleteChatThreadDialog />
    </>
  );
}

function VirtualizedChatThreads({
  scrollSignals,
  threadCount,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  threadCount: number;
}) {
  const setShortcutRoot = useSet(setThreadListNumberShortcutRoot$);
  const searchOpen = useGet(threeColumnSearchOpen$);
  const window = useLastResolved(scrollSignals.window$, {
    equalityFn: equalSidebarChatThreadWindows,
  });
  const startIndex = window?.startIndex ?? 0;
  const visibleItems = window?.items ?? [];

  return (
    <div
      ref={setShortcutRoot}
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
            <ChatThreadItem
              signals={signals}
              shortcutNumber={!searchOpen && index < 9 ? index + 1 : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function ChatThreads({
  scrollSignals,
  threadCount,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  threadCount: number;
}) {
  const { t } = useTranslation();
  const unreadOnly = useGet(chatThreadOnlyUnread$);

  if (threadCount === 0) {
    return (
      <p className="okou-nav-copy-muted px-2 py-2 text-xs text-muted-foreground leading-relaxed">
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
  return (
    <VirtualizedChatThreads
      scrollSignals={scrollSignals}
      threadCount={threadCount}
    />
  );
}

function ChatThreadsListMenuTooltip() {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Ellipsis size={18} />
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

function useNewChatAction() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const createNewChat = useSet(createNewChatThread$);
  const setExpanded = useSet(setSidebarExpanded$);
  const rootSignal = useGet(rootSignal$);
  const newChatDisabled = useGet(newChatThreadDisabled$);

  function onSelect(pane: NewChatThreadPane) {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
    setExpanded(false);
  }

  return {
    disabled: !currentChatAgentId || newChatDisabled,
    onSelect,
  };
}

function useMarkAllReadMenuAction(showMarkAllRead: boolean) {
  const currentChatAgentId = useLastResolved(currentChatAgentId$) ?? null;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
  const [markReadLoadable, markAgentThreadsRead] = useLoadableSet(
    markAgentThreadsRead$,
  );
  const pageSignal = useGet(pageSignal$);
  const markingRead = markReadLoadable.state === "loading";
  const visible =
    showMarkAllRead &&
    currentChatAgentId !== null &&
    (unreadAgentIds?.has(currentChatAgentId) ?? false);

  function onSelect() {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      markAgentThreadsRead(currentChatAgentId, pageSignal),
      Reason.DomCallback,
      "markAgentThreadsRead",
    );
  }

  return { disabled: markingRead, onSelect, visible };
}

function MarkAllReadMenuItem({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <DropdownMenuItem onSelect={onSelect} disabled={disabled}>
      <CheckCheck size={16} className="mr-2" />
      {t(($) => {
        return $.sidebar.markAllRead;
      })}
    </DropdownMenuItem>
  );
}

function ChatThreadFilterMenuItems() {
  const { t } = useTranslation();
  const setCollapsed = useSet(setSessionListCollapsed$);
  const unreadOnly = useGet(chatThreadOnlyUnread$);
  const setUnreadOnly = useSet(setChatThreadOnlyUnread$);

  function toggleUnreadOnly(next: boolean) {
    setUnreadOnly(next);
    if (next) {
      setCollapsed(false);
    }
  }

  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          toggleUnreadOnly(false);
        }}
      >
        <Check size={16} className={`mr-2 ${unreadOnly ? "invisible" : ""}`} />
        {t(($) => {
          return $.chat.sidebar.allChats;
        })}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          toggleUnreadOnly(true);
        }}
      >
        <Check size={16} className={`mr-2 ${unreadOnly ? "" : "invisible"}`} />
        {t(($) => {
          return $.chat.sidebar.unreadOnly;
        })}
      </DropdownMenuItem>
    </>
  );
}

function ChatThreadsListMenu({
  showMarkAllRead,
}: {
  showMarkAllRead: boolean;
}) {
  const { t } = useTranslation();
  const markAllReadAction = useMarkAllReadMenuAction(showMarkAllRead);

  return (
    <TooltipProvider delayDuration={200}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
            }}
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className="relative z-10 shrink-0"
            aria-label={t(($) => {
              return $.chat.sidebar.openListMenu;
            })}
          >
            <ChatThreadsListMenuTooltip />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {markAllReadAction.visible ? (
            <>
              <MarkAllReadMenuItem {...markAllReadAction} />
              <DropdownMenuSeparator />
            </>
          ) : null}
          <ChatThreadFilterMenuItems />
        </DropdownMenuContent>
      </DropdownMenu>
    </TooltipProvider>
  );
}

function ChatThreadsTitle({ showMarkAllRead }: { showMarkAllRead: boolean }) {
  const { t } = useTranslation();
  const { titleLabel } = useChatThreadsTitleLabels();
  const newChatAction = useNewChatAction();
  const newChatLabel = t(($) => {
    return $.chat.newChat;
  });
  const setCollapsed = useSet(setSessionListCollapsed$);
  const collapsed = useGet(sessionListCollapsed$);

  return (
    <div
      className="okou-nav-recent-label group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-state-hover transition-colors"
      onClick={() => {
        return setCollapsed(!collapsed);
      }}
    >
      <span className="okou-nav-copy-muted okou-nav-copy-muted-hover flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-muted-foreground group-hover:text-sidebar-foreground transition-colors">
        {titleLabel}
        <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <ChevronRight
            className={`opacity-35 ${collapsed ? "" : "rotate-90"}`}
            size={12}
          />
        </span>
      </span>
      <div className="flex items-center gap-0.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  newChatAction.onSelect("main");
                }}
                disabled={newChatAction.disabled}
                variant="quiet"
                size="icon-sm"
                iconSize="md"
                className="relative z-10 shrink-0"
                aria-label={newChatLabel}
              >
                <Plus size={18} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{newChatLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <ChatThreadsListMenu showMarkAllRead={showMarkAllRead} />
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

function markPointerFocus(viewport: HTMLElement, signal: AbortSignal) {
  signal.throwIfAborted();
  const token = Math.random().toString(36);
  viewport.dataset.sidebarPointerFocusToken = token;
  const clearPointerFocus = () => {
    if (viewport.dataset.sidebarPointerFocusToken !== token) {
      return;
    }

    delete viewport.dataset.sidebarPointerFocusToken;
  };
  const clearPointerFocusOnAbort = () => {
    clearPointerFocus();
  };
  signal.addEventListener("abort", clearPointerFocusOnAbort, { once: true });
  timeout(
    () => {
      signal.removeEventListener("abort", clearPointerFocusOnAbort);
      clearPointerFocus();
    },
    350,
    { signal },
  );
}

function consumePointerFocus(viewport: HTMLElement) {
  if (!viewport.dataset.sidebarPointerFocusToken) {
    return false;
  }

  delete viewport.dataset.sidebarPointerFocusToken;
  return true;
}

function ChatThreadsContent({
  scrollSignals,
  contentClassName,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const collapsed = useGet(sessionListCollapsed$);

  if (collapsed) {
    return null;
  }

  return (
    <ExpandedChatThreadsContent
      scrollSignals={scrollSignals}
      contentClassName={contentClassName}
    />
  );
}

function AgentChatThreadsContent({
  currentMainThreadId,
  scrollSignals,
}: {
  currentMainThreadId: string | null;
  scrollSignals: SidebarChatThreadScrollSignals;
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
  const scrollCurrentChatThreadOnRef = useSet(
    scrollSignals.scrollCurrentChatThreadOnRef$,
  );

  return (
    <div className="flex flex-col gap-1">
      {currentMainThreadId && currentMainThreadListed ? (
        <span
          ref={scrollCurrentChatThreadOnRef}
          data-chat-thread-id={currentMainThreadId}
          hidden
        />
      ) : null}
      {chatThreadsLoading ? (
        <ChatThreadsSkeleton />
      ) : (
        <ChatThreads scrollSignals={scrollSignals} threadCount={threadCount} />
      )}
    </div>
  );
}

function ExpandedChatThreadsContent({
  scrollSignals,
  contentClassName,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
}) {
  const { t } = useTranslation();
  const agentScope = useGet(currentChatAgentScope$);
  const isScrolled = useGet(scrollSignals.isScrolled$);
  const currentMainThreadId = useGet(currentChatThreadId$);
  const scrollToThread = useSet(scrollSignals.scrollToThread$);
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
      scrollSignals={scrollSignals}
      className="mt-1 min-h-0 flex-1"
      contentClassName={contentClassName}
      aria-label={t(($) => {
        return $.chat.sidebar.chatThreads;
      })}
      data-testid="sidebar-scroll-area"
      tabIndex={currentMainThreadId ? 0 : undefined}
      onPointerDownCapture={(event) => {
        markPointerFocus(event.currentTarget, pageSignal);
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
      style={{
        boxShadow: isScrolled ? "0 -1px 0 0 hsl(var(--border) / 0.4)" : "none",
      }}
    >
      <AgentChatThreadsContent
        key={agentScope ?? "no-agent"}
        currentMainThreadId={currentMainThreadId}
        scrollSignals={scrollSignals}
      />
    </OverlayScrollArea>
  );
}
export function ChatThreadsSection({
  scrollSignals,
  contentClassName,
  showMarkAllRead = false,
}: {
  scrollSignals: SidebarChatThreadScrollSignals;
  contentClassName: string;
  showMarkAllRead?: boolean;
}) {
  const agentScope = useGet(currentChatAgentScope$);
  const mainStylesheetLoaded = useLastResolved(mainStylesheetLoaded$);

  return (
    <div className="mt-4 flex flex-col min-h-0 flex-1">
      <div className={contentClassName}>
        <ChatThreadsTitle
          key={agentScope ?? "no-agent"}
          showMarkAllRead={showMarkAllRead}
        />
      </div>
      {mainStylesheetLoaded && (
        <ChatThreadsContent
          scrollSignals={scrollSignals}
          contentClassName={contentClassName}
        />
      )}
    </div>
  );
}
