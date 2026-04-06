import { useGet, useSet, useLastLoadable, useLoadable } from "ccstate-react";
import { IconPlus, IconSearch, IconX, IconTrash } from "@tabler/icons-react";
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
import type { ChatThreadListItem } from "@vm0/core";
import {
  chatThreads$,
  deleteChatThread$,
  createNewChatThread$,
  creatingNewSession$,
} from "../../signals/zero-page/zero-chat.ts";
import {
  sidebarChatAgentId$,
  navigateToChat$,
  chatThreadId$,
} from "../../signals/zero-page/zero-nav.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
import {
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { useAgentAvatar } from "./zero-sidebar-shared.tsx";

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

  const currentChatAgentId = useGet(sidebarChatAgentId$);
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const displayName = useLastLoadable(agentDisplayName$);
  const displayNameStr =
    displayName.state === "hasData" ? (displayName.data ?? "Zero") : "Zero";

  const selectedRecentId = useGet(chatThreadId$);
  const navigateToChat = useSet(navigateToChat$);
  const createNewChat = useSet(createNewChatThread$);
  const creatingLoadable = useLoadable(creatingNewSession$);
  const creating = creatingLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);

  const searchTerm = useGet(chatListQuery$);
  const setSearchTerm = useSet(setChatListQuery$);

  const avatarSrc = useAgentAvatar(
    currentChatAgentId ?? defaultAgentRawName ?? "",
  );

  // Filter sessions by current agent
  const subagentIds = new Set(
    subagents.map((a) => {
      return a.id;
    }),
  );
  const agentSessions = currentChatAgentId
    ? recentSessions.filter((s) => {
        return s.agentId === currentChatAgentId;
      })
    : recentSessions.filter((s) => {
        return !subagentIds.has(s.agentId);
      });

  const matchedAgent = subagents.find((a) => {
    return a.id === currentChatAgentId;
  });
  const agentLabel = currentChatAgentId
    ? (matchedAgent?.displayName ?? matchedAgent?.id ?? displayNameStr)
    : displayNameStr;

  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions = trimmedTerm
    ? agentSessions.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : agentSessions;

  const onNewChat = () => {
    detach(
      createNewChat(currentChatAgentId ?? null, pageSignal),
      Reason.DomCallback,
    );
  };

  const onRecentSelect = (chatThreadId: string) => {
    navigateToChat(chatThreadId);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="flex items-center gap-3 mb-3">
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt=""
              className="h-8 w-8 rounded-full object-cover object-top"
            />
          ) : (
            <div className="h-8 w-8 rounded-full bg-muted" />
          )}
          <h1 className="text-lg font-semibold">Chats with {agentLabel}</h1>
        </div>

        {/* Search */}
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
            placeholder={`Search chats with ${agentLabel}`}
            className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {searchTerm && (
            <button
              type="button"
              onPointerDown={() => {
                return setSearchTerm("");
              }}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <IconX size={14} stroke={2} />
            </button>
          )}
        </div>
      </div>

      {/* New chat button */}
      <div className="shrink-0 px-4 py-2">
        <button
          type="button"
          onPointerDown={onNewChat}
          disabled={creating}
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
          sessions={filteredSessions}
          searchTerm={searchTerm}
          selectedRecentId={selectedRecentId}
          onRecentSelect={onRecentSelect}
        />
      </div>
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
              onPointerDown={() => {
                return setPendingDeleteThreadId(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onPointerDown={confirmDelete}>
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
        pathname="/chats/:id"
        options={{ pathParams: { id: session.id } }}
        onPointerDown={(e) => {
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
          onPointerDown={(e) => {
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
