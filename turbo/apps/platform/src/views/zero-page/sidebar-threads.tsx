import {
  useGet,
  useSet,
  useLastResolved,
  useLoadable,
  useLastLoadable,
} from "ccstate-react";
import {
  IconSearch,
  IconX,
  IconPlus,
  IconChevronRight,
  IconTrash,
} from "@tabler/icons-react";
import type { ChatThreadListItem } from "@vm0/core";
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
import { detach, Reason } from "../../signals/utils.ts";
import {
  chatThreads$,
  deleteChatThread$,
  createNewChatThread$,
  creatingNewSession$,
} from "../../signals/chat-page/chat-message.ts";
import {
  currentChatAgentId$,
  currentChatThreadId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import {
  navigateToChat$,
  setSidebarExpanded$,
} from "../../signals/zero-page/zero-nav.ts";
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

function ChatThreadItem({
  session,
  isSelected,
  onSelect,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  onSelect?: (id: string) => void;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);

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
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }
          e.preventDefault();
          onSelect?.(session.id);
        }}
        className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
          isSelected
            ? "bg-gray-200 text-gray-900 font-medium"
            : "text-sidebar-foreground hover:bg-sidebar-accent"
        }`}
      >
        <span className="truncate min-w-0 flex-1">
          {session.title ?? "New chat"}
        </span>
      </Link>
      <div className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleDeleteClick}
                className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                  isSelected
                    ? "text-slate-500 hover:text-slate-900 hover:bg-slate-300"
                    : "text-sidebar-foreground/80 hover:text-foreground hover:bg-sidebar-foreground/10"
                }`}
                aria-label="Delete chat"
              >
                <IconTrash size={12} stroke={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Delete chat</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function ChatThreads() {
  const currentChatThreadId = useGet(currentChatThreadId$);
  const navigateToChat = useSet(navigateToChat$);
  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const deleteChatThread = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  const chatThreads = useLastResolved(chatThreads$) ?? [];
  const searchTerm = useGet(sidebarSearchTerm$);
  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredChatThreads = trimmedTerm
    ? chatThreads.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : chatThreads;

  const onRecentSelect = (chatThreadId: string) => {
    navigateToChat(chatThreadId);
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
        return (
          <ChatThreadItem
            key={session.id}
            session={session}
            isSelected={currentChatThreadId === session.id}
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
  const creatingLoadable = useLoadable(creatingNewSession$);
  const setExpanded = useSet(setSidebarExpanded$);
  const createNewChat = useSet(createNewChatThread$);
  const pageSignal = useGet(pageSignal$);

  const agentDisplayName = useLastResolved(currentChatAgentDisplayName$);
  const newChatDisabled = creatingLoadable.state === "loading";
  const onNewChat = () => {
    detach(createNewChat(currentChatAgentId, pageSignal), Reason.DomCallback);
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
        placeholder={`Search chat with ${agentDisplayName}`}
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
      className="zero-nav-recent-label group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent/50 transition-colors"
      onClick={() => {
        return setCollapsed(!collapsed);
      }}
    >
      <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
        Chats with {agentDisplayName}
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
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
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
                className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
                aria-label={`New chat with ${agentDisplayName}`}
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
