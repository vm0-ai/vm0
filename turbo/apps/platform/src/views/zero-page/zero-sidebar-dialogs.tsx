// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode, SyntheticEvent } from "react";
import { useGet, useSet, useLastResolved, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronRight, Loader2, Search, X, Pin, PinOff } from "lucide-react";
import type { ChatSearchResult } from "@okouai/api-contracts/contracts/chat-threads";
import {
  Button,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  RunningIndicator,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  chatListQuery$,
  setChatListQuery$,
  setThreeColumnSearchFilter$,
  threeColumnSearchFilter$,
  type ThreeColumnSearchFilter,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  defaultAgentId$,
  leadAgentAvatarUrl$,
  type SubagentInfo,
} from "../../signals/agent.ts";
import {
  pinnedAgentIds$,
  setAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  sidebarActiveThreadIds$,
  unreadAgentIds$,
} from "../../signals/chat-page/chat-thread-indicators.ts";
import { sidebarUnreadThreadIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import {
  agentListDialogChatMessages$,
  agentListDialogChatThreadMap$,
  agentListDialogChatThreads$,
  agentListDialogSearchResultCounts,
  rankAgentListDialogAgents,
  type AgentListDialogChatThread,
} from "../../signals/zero-page/agent-list-dialog-chat-threads.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { equalSets } from "../../lib/equality.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { AgentRowSideActions } from "./zero-sidebar-agent-row-actions.tsx";

interface AgentDialogItem {
  readonly id: string;
  readonly displayName?: string | null;
}

function agentDialogLabel(agent: AgentDialogItem): string {
  return agent.displayName ?? agent.id;
}

export function agentDialogMatchesQuery(
  agent: AgentDialogItem,
  trimmedQuery: string,
): boolean {
  return (
    agent.id.toLowerCase().includes(trimmedQuery) ||
    (agent.displayName ?? "").toLowerCase().includes(trimmedQuery)
  );
}

export function AgentDialogSearch({
  query,
  setQuery,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <div className="px-5 pb-3">
      <div className="relative w-full">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => {
            return setQuery(e.target.value);
          }}
          placeholder={t(($) => {
            return $.sidebar.searchAgents;
          })}
          className={`pl-9 ${query ? "pr-9" : ""}`}
        />
        {query && (
          <Button
            type="button"
            onClick={() => {
              return setQuery("");
            }}
            variant="quiet"
            size="icon-xs"
            className="absolute right-1.5 top-1/2 shrink-0 -translate-y-1/2"
            aria-label={t(($) => {
              return $.sidebar.clearSearch;
            })}
          >
            <X size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function AgentDialogSection({
  label,
  children,
  className = "pb-2",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={`px-5 ${className}`}>
      <span className="px-1 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 flex flex-col">{children}</div>
    </div>
  );
}

export function AgentDialogAgentButton({
  agent,
  onSelect,
  avatar,
  subtitle,
}: {
  readonly agent: AgentDialogItem;
  readonly onSelect: () => void;
  readonly avatar?: ReactNode;
  readonly subtitle?: ReactNode;
}) {
  const label = agentDialogLabel(agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
    >
      {avatar ?? (
        <AgentAvatarImg
          name={agent.id}
          alt={label}
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function AgentCommandSearch({
  query,
  setQuery,
  placeholder,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly placeholder: string;
}) {
  const { t } = useTranslation("agents");

  return (
    <div className="px-5 pb-3">
      <div className="relative w-full">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={placeholder}
          className={query ? "pr-7" : ""}
        />
        {query && (
          <Button
            type="button"
            onClick={() => {
              return setQuery("");
            }}
            variant="quiet"
            size="icon-xs"
            className="absolute right-1.5 top-1/2 shrink-0 -translate-y-1/2"
            aria-label={t(($) => {
              return $.sidebar.clearSearch;
            })}
          >
            <X size={14} />
          </Button>
        )}
      </div>
    </div>
  );
}

function AgentCommandSection({
  label,
  children,
  className = "pb-2",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <CommandGroup
      heading={label}
      className={`px-5 ${className} [&_[cmdk-group-items]]:mt-1 [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col`}
    >
      {children}
    </CommandGroup>
  );
}

function AgentCommandAgentContent({
  agent,
  avatar,
  subtitle,
}: {
  readonly agent: AgentDialogItem;
  readonly avatar?: ReactNode;
  readonly subtitle?: ReactNode;
}) {
  const label = agentDialogLabel(agent);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
      {avatar ?? (
        <AgentAvatarImg
          name={agent.id}
          alt={label}
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function filterAgentDialogItems<T extends AgentDialogItem>(
  agents: readonly T[],
  trimmedQuery: string,
): T[] {
  if (!trimmedQuery) {
    return [...agents];
  }
  return agents.filter((agent) => {
    return agentDialogMatchesQuery(agent, trimmedQuery);
  });
}

function setHasId(
  set: ReadonlySet<string> | undefined,
  id: string | null | undefined,
): boolean {
  return id ? (set?.has(id) ?? false) : false;
}

type ChatThreadCommandIndicatorValue = "running" | "unread" | null;

function chatThreadCommandIndicator(
  threadId: string,
  activeThreadIds: ReadonlySet<string> | undefined,
  unreadThreadIds: ReadonlySet<string> | undefined,
): ChatThreadCommandIndicatorValue {
  if (activeThreadIds?.has(threadId)) {
    return "running";
  }
  return unreadThreadIds?.has(threadId) ? "unread" : null;
}

function ChatThreadCommandIndicator({
  indicator,
}: {
  readonly indicator: ChatThreadCommandIndicatorValue;
}) {
  const { t } = useTranslation("agents");

  if (indicator === "running") {
    return <RunningIndicator />;
  }
  if (indicator === "unread") {
    return (
      <span
        aria-label={t(($) => {
          return $.status.unread;
        })}
        className="h-2 w-2 rounded-full bg-sky-600"
      />
    );
  }
  return null;
}

function ChatThreadCommandItem({
  thread,
  indicator,
  onSelect,
}: {
  readonly thread: AgentListDialogChatThread;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`thread-${thread.id}`}
      onSelect={onSelect}
      className="group w-full gap-2 px-1 py-2"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <AgentAvatarImg
          name={thread.agentId}
          alt=""
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {thread.title}
          </span>
        </span>
      </span>
      {indicator ? (
        <span className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center">
          <ChatThreadCommandIndicator indicator={indicator} />
        </span>
      ) : null}
    </CommandItem>
  );
}

function stopCommandItemEvent(e: SyntheticEvent) {
  e.stopPropagation();
}

function AgentCommandSideActions({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div
      onPointerDown={stopCommandItemEvent}
      onMouseDown={stopCommandItemEvent}
      onClick={stopCommandItemEvent}
      className="ml-auto shrink-0"
    >
      {children}
    </div>
  );
}

function PinnedAgentCommandItem({
  agent,
  onUnpin,
  onChat,
  disabled,
  hasUnread,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
  onChat?: () => void;
  disabled?: boolean;
  hasUnread: boolean;
}) {
  const { t } = useTranslation("agents");

  return (
    <CommandItem
      value={agent.id}
      onSelect={onChat}
      className="group w-full gap-2 px-1 py-2"
    >
      <AgentCommandAgentContent agent={agent} />
      <div className="flex shrink-0 items-center gap-0.5">
        <AgentCommandSideActions>
          <AgentRowSideActions
            hasUnread={hasUnread}
            action={{
              label: t(($) => {
                return $.sidebar.unpin;
              }),
              disabled,
              icon: <PinOff size={16} />,
              onSelect: onUnpin,
            }}
          />
        </AgentCommandSideActions>
      </div>
    </CommandItem>
  );
}

function LeadAgentCommandSection({
  displayName,
  show,
  zeroAvatarUrl,
  defaultAgentId,
  unreadAgentIds,
  onChat,
}: {
  readonly displayName: string;
  readonly show: boolean;
  readonly zeroAvatarUrl: string | null;
  readonly defaultAgentId: string | null | undefined;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: () => void;
}) {
  const { t } = useTranslation("agents");

  if (!show) {
    return null;
  }
  return (
    <AgentCommandSection
      label={t(($) => {
        return $.sidebar.sections.lead;
      })}
    >
      <CommandItem
        value="lead"
        onSelect={onChat}
        className="group w-full gap-2 px-1 py-2"
      >
        <AgentCommandAgentContent
          agent={{ id: "lead", displayName }}
          avatar={
            <AvatarFromUrl
              avatarUrl={zeroAvatarUrl}
              alt={displayName}
              className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
            />
          }
          subtitle={t(($) => {
            return $.sidebar.leadDescription;
          })}
        />
        <AgentCommandSideActions>
          <AgentRowSideActions
            hasUnread={setHasId(unreadAgentIds, defaultAgentId)}
          />
        </AgentCommandSideActions>
      </CommandItem>
    </AgentCommandSection>
  );
}

function PinnedAgentsCommandSection({
  agents,
  disabled,
  unreadAgentIds,
  onChat,
  onTogglePin,
}: {
  readonly agents: readonly SubagentInfo[];
  readonly disabled: boolean;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: (agentId: string) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  const { t } = useTranslation("agents");

  if (agents.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection
      label={t(($) => {
        return $.sidebar.pinned;
      })}
    >
      {agents.map((agent) => {
        return (
          <PinnedAgentCommandItem
            key={agent.id}
            agent={agent}
            onUnpin={() => {
              return onTogglePin(agent.id);
            }}
            onChat={() => {
              return onChat(agent.id);
            }}
            disabled={disabled}
            hasUnread={setHasId(unreadAgentIds, agent.id)}
          />
        );
      })}
    </AgentCommandSection>
  );
}

function UnpinnedAgentsCommandSection({
  agents,
  disabled,
  unreadAgentIds,
  onChat,
  onTogglePin,
}: {
  readonly agents: readonly SubagentInfo[];
  readonly disabled: boolean;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: (agentId: string) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  const { t } = useTranslation("agents");

  if (agents.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection
      label={t(($) => {
        return $.sidebar.sections.others;
      })}
      className="pb-3"
    >
      {agents.map((agent) => {
        return (
          <CommandItem
            key={agent.id}
            value={agent.id}
            onSelect={() => {
              return onChat(agent.id);
            }}
            className="group w-full gap-2 px-1 py-2"
          >
            <AgentCommandAgentContent agent={agent} />
            <AgentCommandSideActions>
              <AgentRowSideActions
                hasUnread={setHasId(unreadAgentIds, agent.id)}
                action={{
                  label: t(($) => {
                    return $.sidebar.pin;
                  }),
                  disabled,
                  icon: <Pin size={16} />,
                  onSelect: () => {
                    return onTogglePin(agent.id);
                  },
                }}
              />
            </AgentCommandSideActions>
          </CommandItem>
        );
      })}
    </AgentCommandSection>
  );
}

function ChatThreadCommandSection({
  threads,
  activeThreadIds,
  unreadThreadIds,
  onSelect,
}: {
  readonly threads: readonly AgentListDialogChatThread[];
  readonly activeThreadIds: ReadonlySet<string> | undefined;
  readonly unreadThreadIds: ReadonlySet<string> | undefined;
  readonly onSelect: (threadId: string) => void;
}) {
  const { t } = useTranslation("agents");

  if (threads.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection
      label={t(($) => {
        return $.sidebar.sections.chats;
      })}
      className="pb-3"
    >
      {threads.map((thread) => {
        return (
          <ChatThreadCommandItem
            key={thread.id}
            thread={thread}
            indicator={chatThreadCommandIndicator(
              thread.id,
              activeThreadIds,
              unreadThreadIds,
            )}
            onSelect={() => {
              return onSelect(thread.id);
            }}
          />
        );
      })}
    </AgentCommandSection>
  );
}

function ChatThreadCommandSectionContainer({
  query,
  onSelect,
}: {
  readonly query: string;
  readonly onSelect: (threadId: string) => void;
}) {
  const result = useGet(agentListDialogChatThreads$);
  const activeThreadIds = useLastResolved(sidebarActiveThreadIds$, {
    equalityFn: equalSets,
  });
  const unreadThreadIds = useLastResolved(sidebarUnreadThreadIds$, {
    equalityFn: equalSets,
  });
  const currentResult = result.query === query ? result : undefined;
  const threads = currentResult?.chatThreads ?? [];

  return (
    <ChatThreadCommandSection
      threads={threads}
      activeThreadIds={activeThreadIds}
      unreadThreadIds={unreadThreadIds}
      onSelect={onSelect}
    />
  );
}

interface UnifiedAgentSearchItem extends AgentDialogItem {
  readonly kind: "agent";
  readonly agentId: string | null;
  readonly isLead: boolean;
}

interface UnifiedThreadSearchItem {
  readonly kind: "thread";
  readonly thread: AgentListDialogChatThread;
}

interface UnifiedMessageSearchItem {
  readonly kind: "message";
  readonly message: ChatSearchResult;
  readonly thread: AgentListDialogChatThread | undefined;
}

interface UnifiedSearchingItem {
  readonly kind: "searching";
}

type UnifiedSearchItem =
  | UnifiedAgentSearchItem
  | UnifiedThreadSearchItem
  | UnifiedMessageSearchItem
  | UnifiedSearchingItem;

interface ChatMessageSnippetPart {
  readonly start: number;
  readonly text: string;
  readonly matched: boolean;
}

const CHAT_MESSAGE_SNIPPET_LENGTH = 140;

function avoidSplitSurrogateStart(content: string, start: number): number {
  if (start === 0) {
    return start;
  }
  const code = content.charCodeAt(start);
  return code >= 0xdc_00 && code <= 0xdf_ff ? start - 1 : start;
}

function avoidSplitSurrogateEnd(content: string, end: number): number {
  if (end === content.length) {
    return end;
  }
  const code = content.charCodeAt(end - 1);
  return code >= 0xd8_00 && code <= 0xdb_ff ? end + 1 : end;
}

function chatMessageSnippetParts(
  content: string,
  ranges: ChatSearchResult["matchedRanges"],
): ChatMessageSnippetPart[] {
  const validRanges = ranges.filter((range) => {
    return (
      range.start >= 0 && range.end > range.start && range.end <= content.length
    );
  });
  const firstRange = validRanges[0] ?? { start: 0, end: 0 };
  const matchLength = firstRange.end - firstRange.start;
  const contextLength = Math.max(0, CHAT_MESSAGE_SNIPPET_LENGTH - matchLength);
  let start = Math.max(0, firstRange.start - Math.floor(contextLength / 2));
  let end = Math.min(content.length, start + CHAT_MESSAGE_SNIPPET_LENGTH);
  start = Math.max(0, end - CHAT_MESSAGE_SNIPPET_LENGTH);
  start = avoidSplitSurrogateStart(content, start);
  end = avoidSplitSurrogateEnd(content, end);

  const visibleRanges = validRanges.flatMap((range) => {
    const visibleStart = Math.max(start, range.start);
    const visibleEnd = Math.min(end, range.end);
    return visibleStart < visibleEnd
      ? [{ start: visibleStart, end: visibleEnd }]
      : [];
  });
  const parts: ChatMessageSnippetPart[] = [];
  let cursor = start;
  for (const range of visibleRanges) {
    if (range.start > cursor) {
      parts.push({
        start: cursor,
        text: content.slice(cursor, range.start),
        matched: false,
      });
    }
    parts.push({
      start: range.start,
      text: content.slice(range.start, range.end),
      matched: true,
    });
    cursor = range.end;
  }
  if (cursor < end) {
    parts.push({
      start: cursor,
      text: content.slice(cursor, end),
      matched: false,
    });
  }
  return parts;
}

function ChatMessageSnippet({
  message,
}: {
  readonly message: ChatSearchResult;
}) {
  const content = message.matchedMessage.content;
  const parts = chatMessageSnippetParts(content, message.matchedRanges);
  return (
    <span
      className="block truncate text-xs text-muted-foreground"
      aria-label={content}
    >
      <span aria-hidden="true">… </span>
      {parts.map((part) => {
        return (
          <span
            key={`${part.start}-${part.matched ? "match" : "text"}`}
            className={part.matched ? "font-medium text-foreground" : undefined}
          >
            {part.text}
          </span>
        );
      })}
      <span aria-hidden="true"> …</span>
    </span>
  );
}

function ChatMessageCommandItem({
  message,
  thread,
  indicator,
  onSelect,
}: {
  readonly message: ChatSearchResult;
  readonly thread: AgentListDialogChatThread | undefined;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
}) {
  const title = thread?.title ?? message.agentName;
  return (
    <CommandItem
      value={`message-${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
      onSelect={onSelect}
      className="group w-full gap-2 px-1 py-2"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <AgentAvatarImg
          name={thread?.agentId ?? message.agentName}
          alt=""
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {title}
          </span>
          <ChatMessageSnippet message={message} />
        </span>
      </span>
      {indicator ? (
        <span className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center">
          <ChatThreadCommandIndicator indicator={indicator} />
        </span>
      ) : null}
    </CommandItem>
  );
}

function SpotlightResultType({ children }: { readonly children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  );
}

function SpotlightThreadCommandItem({
  thread,
  indicator,
  onSelect,
}: {
  readonly thread: AgentListDialogChatThread;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation("agents");

  return (
    <CommandItem
      value={`spotlight-thread-${thread.id}`}
      onSelect={onSelect}
      className="group w-full gap-3 px-2 py-2.5"
    >
      <AgentAvatarImg
        name={thread.agentId}
        alt=""
        className="h-9 w-9 shrink-0 rounded-xl object-cover object-top"
      />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="truncate text-sm font-medium text-foreground">
          {thread.title}
        </span>
        <SpotlightResultType>
          {t(($) => {
            return $.sidebar.chatResult;
          })}
        </SpotlightResultType>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
        <ChatThreadCommandIndicator indicator={indicator} />
        <ChevronRight size={15} aria-hidden="true" />
      </span>
    </CommandItem>
  );
}

function SpotlightMessageCommandItem({
  message,
  thread,
  indicator,
  onSelect,
}: {
  readonly message: ChatSearchResult;
  readonly thread: AgentListDialogChatThread | undefined;
  readonly indicator: ChatThreadCommandIndicatorValue;
  readonly onSelect: () => void;
}) {
  const { t } = useTranslation("agents");
  const title = thread?.title ?? message.agentName;

  return (
    <CommandItem
      value={`spotlight-message-${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
      onSelect={onSelect}
      className="group w-full gap-3 px-2 py-2.5"
    >
      <AgentAvatarImg
        name={thread?.agentId ?? message.agentName}
        alt=""
        className="h-9 w-9 shrink-0 rounded-xl object-cover object-top"
      />
      <span className="min-w-0 flex-1 text-left">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <SpotlightResultType>
            {t(($) => {
              return $.sidebar.messageResult;
            })}
          </SpotlightResultType>
        </span>
        <ChatMessageSnippet message={message} />
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 text-muted-foreground">
        <ChatThreadCommandIndicator indicator={indicator} />
        <ChevronRight size={15} aria-hidden="true" />
      </span>
    </CommandItem>
  );
}

function SpotlightFilterButton({
  active,
  label,
  onSelect,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      role="tab"
      aria-selected={active}
      variant={active ? "outline" : "quiet"}
      size="xs"
      className="h-7 rounded-full px-3 text-xs font-normal"
      onClick={onSelect}
    >
      {label}
    </Button>
  );
}

export function ThreeColumnSearchDialog({
  open,
  onOpenChange,
  onSelectChatThread,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectChatThread: (threadId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const filter = useGet(threeColumnSearchFilter$);
  const setFilter = useSet(setThreeColumnSearchFilter$);
  const threadResult = useGet(agentListDialogChatThreads$);
  const threadMap = useGet(agentListDialogChatThreadMap$);
  const messageLoadable = useLoadable(agentListDialogChatMessages$);
  const activeThreadIds = useLastResolved(sidebarActiveThreadIds$, {
    equalityFn: equalSets,
  });
  const unreadThreadIds = useLastResolved(sidebarUnreadThreadIds$, {
    equalityFn: equalSets,
  });
  const trimmedQuery = query.trim().toLowerCase();
  const threadMatches =
    threadResult.query === trimmedQuery ? threadResult.chatThreads : [];
  const messageResult =
    messageLoadable.state === "hasData" &&
    messageLoadable.data.query === trimmedQuery
      ? messageLoadable.data
      : undefined;
  const messageMatches = messageResult?.chatMessages ?? [];
  const searching =
    messageLoadable.state === "loading" ||
    (messageLoadable.state === "hasData" &&
      messageLoadable.data.query !== trimmedQuery);
  const showThreads = filter !== "messages";
  const showMessages = filter !== "chats";
  const resultCount =
    (showThreads ? threadMatches.length : 0) +
    (showMessages ? messageMatches.length : 0);
  const showNoResults = !searching && resultCount === 0;
  const selectThread = (threadId: string) => {
    onOpenChange(false);
    onSelectChatThread(threadId);
  };
  const filterOptions: readonly {
    readonly value: ThreeColumnSearchFilter;
    readonly label: string;
  }[] = [
    {
      value: "all",
      label: t(($) => {
        return $.sidebar.filterAll;
      }),
    },
    {
      value: "chats",
      label: t(($) => {
        return $.sidebar.sections.chats;
      }),
    },
    {
      value: "messages",
      label: t(($) => {
        return $.sidebar.sections.messages;
      }),
    },
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      className="zero-app w-[calc(100vw-2rem)] gap-0 rounded-[var(--zero-composer-radius)] sm:max-w-[820px] [&_[data-slot=dialog-close]]:hidden"
      commandClassName="gap-0 rounded-[var(--zero-composer-radius)]"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>
          {t(($) => {
            return $.sidebar.searchChatsAndMessages;
          })}
        </DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.sidebar.searchChatsAndMessages;
          })}
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 pb-4 pt-5">
        <div className="relative">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t(($) => {
              return $.sidebar.searchChatsAndMessages;
            })}
            wrapperClassName="h-12 rounded-xl"
            className="pr-12 text-[15px] placeholder:text-[15px]"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md border-[0.7px] border-[hsl(var(--gray-300))] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t(($) => {
              return $.sidebar.escapeShortcut;
            })}
          </kbd>
        </div>
      </div>

      <div className="flex items-center justify-between border-y-[0.7px] border-[hsl(var(--gray-300))] px-5 py-3">
        <div role="tablist" className="flex items-center gap-1">
          {filterOptions.map((option) => {
            return (
              <SpotlightFilterButton
                key={option.value}
                active={filter === option.value}
                label={option.label}
                onSelect={() => {
                  return setFilter(option.value);
                }}
              />
            );
          })}
        </div>
        <span className="text-xs text-muted-foreground" role="status">
          {t(
            ($) => {
              return $.sidebar.resultCount;
            },
            { count: resultCount },
          )}
        </span>
      </div>

      <CommandList className="min-h-[300px] max-h-[min(560px,65vh)] pb-3 pt-2">
        <CommandGroup
          heading={t(($) => {
            return $.sidebar.bestMatches;
          })}
          className="px-5 [&_[cmdk-group-items]]:mt-1 [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col"
        >
          {showThreads
            ? threadMatches.map((thread) => {
                return (
                  <SpotlightThreadCommandItem
                    key={thread.id}
                    thread={thread}
                    indicator={chatThreadCommandIndicator(
                      thread.id,
                      activeThreadIds,
                      unreadThreadIds,
                    )}
                    onSelect={() => {
                      return selectThread(thread.id);
                    }}
                  />
                );
              })
            : null}
          {showMessages
            ? messageMatches.map((message) => {
                return (
                  <SpotlightMessageCommandItem
                    key={`${message.matchedMessage.chatThreadId}:${message.matchedMessage.seqId}`}
                    message={message}
                    thread={threadMap.get(message.chatThreadId)}
                    indicator={chatThreadCommandIndicator(
                      message.chatThreadId,
                      activeThreadIds,
                      unreadThreadIds,
                    )}
                    onSelect={() => {
                      return selectThread(message.chatThreadId);
                    }}
                  />
                );
              })
            : null}
          {searching && showMessages ? (
            <div
              className="flex items-center gap-2 px-2 py-2.5 text-xs text-muted-foreground"
              role="status"
            >
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t(($) => {
                return $.sidebar.searching;
              })}
            </div>
          ) : null}
          {showNoResults ? (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              {t(($) => {
                return $.sidebar.noResults;
              })}
            </p>
          ) : null}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

function UnifiedAgentCommandItem({
  item,
  zeroAvatarUrl,
  defaultAgentId,
  unreadAgentIds,
  pinnedIdSet,
  saving,
  onChat,
  onTogglePin,
}: {
  readonly item: UnifiedAgentSearchItem;
  readonly zeroAvatarUrl: string | null;
  readonly defaultAgentId: string | null | undefined;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly pinnedIdSet: ReadonlySet<string>;
  readonly saving: boolean;
  readonly onChat: (agentId: string | null) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const agentId = item.agentId;
  const pinned = agentId ? pinnedIdSet.has(agentId) : false;
  return (
    <CommandItem
      value={`agent-${item.agentId ?? "lead"}`}
      onSelect={() => {
        return onChat(item.agentId);
      }}
      className="group w-full gap-2 px-1 py-2"
    >
      <AgentCommandAgentContent
        agent={item}
        avatar={
          item.isLead ? (
            <AvatarFromUrl
              avatarUrl={zeroAvatarUrl}
              alt={agentDialogLabel(item)}
              className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
            />
          ) : undefined
        }
        subtitle={
          item.isLead
            ? t(($) => {
                return $.sidebar.leadDescription;
              })
            : undefined
        }
      />
      <AgentCommandSideActions>
        <AgentRowSideActions
          hasUnread={setHasId(unreadAgentIds, item.agentId ?? defaultAgentId)}
          action={
            agentId
              ? {
                  label: t(($) => {
                    return pinned ? $.sidebar.unpin : $.sidebar.pin;
                  }),
                  disabled: saving,
                  icon: pinned ? <PinOff size={16} /> : <Pin size={16} />,
                  onSelect: () => {
                    return onTogglePin(agentId);
                  },
                }
              : undefined
          }
        />
      </AgentCommandSideActions>
    </CommandItem>
  );
}

function AgentListDialogUnifiedSearch({
  query,
  displayName,
  subagents,
  zeroAvatarUrl,
  defaultAgentId,
  pinnedIdSet,
  unreadAgentIds,
  saving,
  onChat,
  onSelectThread,
  onTogglePin,
}: {
  readonly query: string;
  readonly displayName: string;
  readonly subagents: readonly SubagentInfo[];
  readonly zeroAvatarUrl: string | null;
  readonly defaultAgentId: string | null | undefined;
  readonly pinnedIdSet: ReadonlySet<string>;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly saving: boolean;
  readonly onChat: (agentId: string | null) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const threadResult = useGet(agentListDialogChatThreads$);
  const threadMap = useGet(agentListDialogChatThreadMap$);
  const messageLoadable = useLoadable(agentListDialogChatMessages$);
  const activeThreadIds = useLastResolved(sidebarActiveThreadIds$, {
    equalityFn: equalSets,
  });
  const unreadThreadIds = useLastResolved(sidebarUnreadThreadIds$, {
    equalityFn: equalSets,
  });
  const orderedSubagents = [...subagents].sort((left, right) => {
    return Number(pinnedIdSet.has(right.id)) - Number(pinnedIdSet.has(left.id));
  });
  const agentMatches = rankAgentListDialogAgents<UnifiedAgentSearchItem>(
    [
      {
        kind: "agent",
        id: "lead",
        displayName,
        agentId: null,
        isLead: true,
      },
      ...orderedSubagents.map((agent) => {
        return {
          kind: "agent" as const,
          id: agent.id,
          displayName: agent.displayName,
          agentId: agent.id,
          isLead: false,
        };
      }),
    ],
    query,
  );
  const threadMatches =
    threadResult.query === query ? threadResult.chatThreads : [];
  const messageResult =
    messageLoadable.state === "hasData" && messageLoadable.data.query === query
      ? messageLoadable.data
      : undefined;
  const messageMatches = messageResult?.chatMessages ?? [];
  const counts = agentListDialogSearchResultCounts({
    agentCount: agentMatches.length,
    threadCount: threadMatches.length,
    messageCount: messageMatches.length,
  });
  const searching =
    messageLoadable.state === "loading" ||
    (messageLoadable.state === "hasData" &&
      messageLoadable.data.query !== query);
  const items: UnifiedSearchItem[] = [
    ...agentMatches.slice(0, counts.agents),
    ...threadMatches.slice(0, counts.threads).map((thread) => {
      return { kind: "thread" as const, thread };
    }),
    ...(searching ? [{ kind: "searching" as const }] : []),
    ...messageMatches.slice(0, counts.messages).map((message) => {
      return {
        kind: "message" as const,
        message,
        thread: threadMap.get(message.chatThreadId),
      };
    }),
  ];
  const hasResult = items.some((item) => {
    return item.kind !== "searching";
  });
  const showNoResults = messageResult !== undefined && !hasResult;

  return (
    <CommandGroup className="px-5 pb-3 [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col">
      {items.map((item) => {
        if (item.kind === "agent") {
          return (
            <UnifiedAgentCommandItem
              key={`agent-${item.agentId ?? "lead"}`}
              item={item}
              zeroAvatarUrl={zeroAvatarUrl}
              defaultAgentId={defaultAgentId}
              unreadAgentIds={unreadAgentIds}
              pinnedIdSet={pinnedIdSet}
              saving={saving}
              onChat={onChat}
              onTogglePin={onTogglePin}
            />
          );
        }
        if (item.kind === "thread") {
          return (
            <ChatThreadCommandItem
              key={`thread-${item.thread.id}`}
              thread={item.thread}
              indicator={chatThreadCommandIndicator(
                item.thread.id,
                activeThreadIds,
                unreadThreadIds,
              )}
              onSelect={() => {
                return onSelectThread(item.thread.id);
              }}
            />
          );
        }
        if (item.kind === "message") {
          return (
            <ChatMessageCommandItem
              key={`message-${item.message.matchedMessage.chatThreadId}:${item.message.matchedMessage.seqId}`}
              message={item.message}
              thread={item.thread}
              indicator={chatThreadCommandIndicator(
                item.message.chatThreadId,
                activeThreadIds,
                unreadThreadIds,
              )}
              onSelect={() => {
                return onSelectThread(item.message.chatThreadId);
              }}
            />
          );
        }
        return (
          <div
            key="searching"
            className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            {t(($) => {
              return $.sidebar.searching;
            })}
          </div>
        );
      })}
      {showNoResults ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {t(($) => {
            return $.sidebar.noResults;
          })}
        </p>
      ) : null}
    </CommandGroup>
  );
}

export function AgentPinDialog({
  open,
  onOpenChange,
  subagents,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly subagents: readonly SubagentInfo[];
}) {
  const { t } = useTranslation("agents");
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const unreadAgentIds = useLastResolved(unreadAgentIds$, {
    equalityFn: equalSets,
  });
  const pageSignal = useGet(pageSignal$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const saving = pinLoadable.state === "loading";
  const pinnedIdSet = new Set(pinnedIds);
  const trimmedQuery = query.trim().toLowerCase();
  const pinned = filterAgentDialogItems(
    subagents.filter((agent) => {
      return pinnedIdSet.has(agent.id);
    }),
    trimmedQuery,
  );
  const unpinned = filterAgentDialogItems(
    subagents.filter((agent) => {
      return !pinnedIdSet.has(agent.id);
    }),
    trimmedQuery,
  );
  const togglePin = (agentId: string) => {
    detach(
      saveAgentPinned(
        { agentId, pinned: !pinnedIdSet.has(agentId) },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      className="zero-app w-[calc(100vw-2rem)] gap-0 sm:max-w-xl"
      commandClassName="gap-0"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <DialogHeader className="px-5 pb-3 pt-5">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.sidebar.pinAgents;
          })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.sidebar.pinAgentsDescription;
          })}
        </DialogDescription>
      </DialogHeader>

      <AgentCommandSearch
        query={query}
        setQuery={setQuery}
        placeholder={t(($) => {
          return $.sidebar.searchAgents;
        })}
      />

      <CommandList>
        <PinnedAgentsCommandSection
          agents={pinned}
          disabled={saving}
          unreadAgentIds={unreadAgentIds}
          onChat={togglePin}
          onTogglePin={togglePin}
        />
        <UnpinnedAgentsCommandSection
          agents={unpinned}
          disabled={saving}
          unreadAgentIds={unreadAgentIds}
          onChat={togglePin}
          onTogglePin={togglePin}
        />
        {pinned.length === 0 && unpinned.length === 0 ? (
          <p className="px-5 py-4 text-center text-sm text-muted-foreground">
            {t(($) => {
              return $.sidebar.noResults;
            })}
          </p>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

export function AgentListDialog({
  open,
  onOpenChange,
  displayName,
  subagents,
  onSelectChatAgent,
  onSelectChatThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  subagents: SubagentInfo[];
  onSelectChatAgent?: (agentId: string | null) => void;
  onSelectChatThread?: (threadId: string) => void;
}) {
  const { t } = useTranslation("agents");
  const zeroAvatarUrl = useLastResolved(leadAgentAvatarUrl$) ?? null;
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const unreadAgentIds = useLastResolved(unreadAgentIds$, {
    equalityFn: equalSets,
  });
  const pageSignal = useGet(pageSignal$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const saving = pinLoadable.state === "loading";

  const pinnedIdSet = new Set(pinnedIds);
  const pinned = subagents.filter((a) => {
    return pinnedIdSet.has(a.id);
  });

  const unpinned = subagents.filter((a) => {
    return !pinnedIdSet.has(a.id);
  });

  const trimmedQuery = query.trim().toLowerCase();
  const filteredPinned = filterAgentDialogItems(pinned, trimmedQuery);
  const filteredUnpinned = filterAgentDialogItems(unpinned, trimmedQuery);
  const showLead =
    !trimmedQuery || displayName.toLowerCase().includes(trimmedQuery);
  const togglePin = (agentId: string) => {
    detach(
      saveAgentPinned(
        { agentId, pinned: !pinnedIdSet.has(agentId) },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handleChat = (agentId: string | null) => {
    onOpenChange(false);
    onSelectChatAgent?.(agentId);
  };

  const handleChatThread = (threadId: string) => {
    onOpenChange(false);
    onSelectChatThread?.(threadId);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      closeLabel={t(($) => {
        return $.actions.close;
      })}
      className="zero-app sm:max-w-xl w-[calc(100vw-2rem)] gap-0"
      commandClassName="gap-0"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <DialogHeader className="px-5 pt-5 pb-3">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.sidebar.talkTo;
          })}
        </DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground mt-1">
          {t(($) => {
            return $.sidebar.descriptionWithChats;
          })}
        </DialogDescription>
      </DialogHeader>

      <AgentCommandSearch
        query={query}
        setQuery={setQuery}
        placeholder={t(($) => {
          return $.sidebar.searchAgentsAndChats;
        })}
      />

      <CommandList>
        {trimmedQuery ? (
          <AgentListDialogUnifiedSearch
            query={trimmedQuery}
            displayName={displayName}
            subagents={subagents}
            zeroAvatarUrl={zeroAvatarUrl}
            defaultAgentId={defaultAgentId}
            pinnedIdSet={pinnedIdSet}
            unreadAgentIds={unreadAgentIds}
            saving={saving}
            onChat={handleChat}
            onSelectThread={handleChatThread}
            onTogglePin={togglePin}
          />
        ) : (
          <>
            <LeadAgentCommandSection
              displayName={displayName}
              show={showLead}
              zeroAvatarUrl={zeroAvatarUrl}
              defaultAgentId={defaultAgentId}
              unreadAgentIds={unreadAgentIds}
              onChat={() => {
                return handleChat(null);
              }}
            />
            <PinnedAgentsCommandSection
              agents={filteredPinned}
              disabled={saving}
              unreadAgentIds={unreadAgentIds}
              onChat={handleChat}
              onTogglePin={togglePin}
            />
            <UnpinnedAgentsCommandSection
              agents={filteredUnpinned}
              disabled={saving}
              unreadAgentIds={unreadAgentIds}
              onChat={handleChat}
              onTogglePin={togglePin}
            />
            <ChatThreadCommandSectionContainer
              query={trimmedQuery}
              onSelect={handleChatThread}
            />
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
