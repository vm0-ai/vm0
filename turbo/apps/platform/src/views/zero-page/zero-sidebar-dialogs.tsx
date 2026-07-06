// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode, SyntheticEvent } from "react";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconSearch, IconX, IconPin, IconPinnedOff } from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ChatThreadListItem } from "@vm0/api-contracts/contracts/chat-threads";
import {
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
} from "@vm0/ui";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  defaultAgentId$,
  leadAgentAvatarUrl$,
  type SubagentInfo,
} from "../../signals/agent.ts";
import { allChatThreadListItems$ } from "../../signals/agent-chat.ts";
import {
  pinnedAgentIds$,
  setAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  sidebarUnreadThreadIds$,
  unreadAgentIds$,
} from "../../signals/chat-page/sidebar-unread-threads.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { AgentRowSideActions } from "./zero-sidebar-agent-row-actions.tsx";

const MAX_VISIBLE_CHAT_THREAD_RESULTS = 25;

export interface AgentDialogItem {
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
  return (
    <div className="px-5 pb-3">
      <div className="relative w-full">
        <IconSearch
          size={16}
          stroke={2}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="text"
          value={query}
          onChange={(e) => {
            return setQuery(e.target.value);
          }}
          placeholder="Search agents..."
          className={`pl-9 ${query ? "pr-9" : ""}`}
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              return setQuery("");
            }}
            className="absolute right-1.5 top-1/2 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
          >
            <IconX size={14} stroke={2} />
          </button>
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
          <button
            type="button"
            onClick={() => {
              return setQuery("");
            }}
            className="absolute right-1.5 top-1/2 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
          >
            <IconX size={14} stroke={2} />
          </button>
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

function chatThreadDialogTitle(thread: ChatThreadListItem): string {
  return thread.title ?? "New chat";
}

function chatThreadDialogMatchesQuery(
  thread: ChatThreadListItem,
  trimmedQuery: string,
): boolean {
  return chatThreadDialogTitle(thread).toLowerCase().includes(trimmedQuery);
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

function filterChatThreadDialogItems({
  enabled,
  threads,
  trimmedQuery,
}: {
  readonly enabled: boolean;
  readonly threads: readonly ChatThreadListItem[];
  readonly trimmedQuery: string;
}): ChatThreadListItem[] {
  if (!enabled) {
    return [];
  }
  const matchingThreads = trimmedQuery
    ? threads.filter((thread) => {
        return chatThreadDialogMatchesQuery(thread, trimmedQuery);
      })
    : threads;
  return matchingThreads.slice(0, MAX_VISIBLE_CHAT_THREAD_RESULTS);
}

function setHasId(
  set: ReadonlySet<string> | undefined,
  id: string | null | undefined,
): boolean {
  return id ? (set?.has(id) ?? false) : false;
}

function agentListDialogDescription(unifiedSearchEnabled: boolean): string {
  if (unifiedSearchEnabled) {
    return "Pick an agent or jump to a chat.";
  }
  return "Pick an agent to start a conversation.";
}

function agentListDialogSearchPlaceholder(
  unifiedSearchEnabled: boolean,
): string {
  if (unifiedSearchEnabled) {
    return "Search agents and chats...";
  }
  return "Search agents...";
}

function ChatThreadCommandIndicator({
  running,
  unread,
}: {
  readonly running: boolean;
  readonly unread: boolean;
}) {
  if (running) {
    return <RunningIndicator />;
  }
  if (unread) {
    return (
      <span aria-label="Unread" className="h-2 w-2 rounded-full bg-sky-600" />
    );
  }
  return null;
}

function ChatThreadCommandItem({
  thread,
  hasUnread,
  onSelect,
}: {
  readonly thread: ChatThreadListItem;
  readonly hasUnread: boolean;
  readonly onSelect: () => void;
}) {
  const title = chatThreadDialogTitle(thread);
  const hasIndicator = thread.running || hasUnread;
  return (
    <CommandItem
      value={`thread-${thread.id}`}
      onSelect={onSelect}
      className="group w-full gap-2 px-1 py-2"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <AgentAvatarImg
          name={thread.agent.id}
          alt=""
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">
            {title}
          </span>
        </span>
      </span>
      {hasIndicator ? (
        <span className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center">
          <ChatThreadCommandIndicator
            running={thread.running}
            unread={hasUnread}
          />
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
  unreadIndicatorsEnabled,
  hasUnread,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
  onChat?: () => void;
  disabled?: boolean;
  unreadIndicatorsEnabled: boolean;
  hasUnread: boolean;
}) {
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
            hasUnread={unreadIndicatorsEnabled && hasUnread}
            action={{
              label: "Unpin",
              disabled,
              icon: <IconPinnedOff size={16} stroke={2} />,
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
  unreadIndicatorsEnabled,
  defaultAgentId,
  unreadAgentIds,
  onChat,
}: {
  readonly displayName: string;
  readonly show: boolean;
  readonly zeroAvatarUrl: string | null;
  readonly unreadIndicatorsEnabled: boolean;
  readonly defaultAgentId: string | null | undefined;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: () => void;
}) {
  if (!show) {
    return null;
  }
  return (
    <AgentCommandSection label="Lead">
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
          subtitle="Your lead assistant, always here for you"
        />
        {unreadIndicatorsEnabled && (
          <AgentCommandSideActions>
            <AgentRowSideActions
              hasUnread={setHasId(unreadAgentIds, defaultAgentId)}
            />
          </AgentCommandSideActions>
        )}
      </CommandItem>
    </AgentCommandSection>
  );
}

function PinnedAgentsCommandSection({
  agents,
  disabled,
  unreadIndicatorsEnabled,
  unreadAgentIds,
  onChat,
  onTogglePin,
}: {
  readonly agents: readonly SubagentInfo[];
  readonly disabled: boolean;
  readonly unreadIndicatorsEnabled: boolean;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: (agentId: string) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  if (agents.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection label="Pinned">
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
            unreadIndicatorsEnabled={unreadIndicatorsEnabled}
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
  unreadIndicatorsEnabled,
  unreadAgentIds,
  onChat,
  onTogglePin,
}: {
  readonly agents: readonly SubagentInfo[];
  readonly disabled: boolean;
  readonly unreadIndicatorsEnabled: boolean;
  readonly unreadAgentIds: ReadonlySet<string> | undefined;
  readonly onChat: (agentId: string) => void;
  readonly onTogglePin: (agentId: string) => void;
}) {
  if (agents.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection label="Others" className="pb-3">
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
                hasUnread={
                  unreadIndicatorsEnabled && setHasId(unreadAgentIds, agent.id)
                }
                action={{
                  label: "Pin to sidebar",
                  disabled,
                  icon: <IconPin size={16} stroke={2} />,
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
  unreadIndicatorsEnabled,
  unreadThreadIds,
  onSelect,
}: {
  readonly threads: readonly ChatThreadListItem[];
  readonly unreadIndicatorsEnabled: boolean;
  readonly unreadThreadIds: ReadonlySet<string> | undefined;
  readonly onSelect: (threadId: string) => void;
}) {
  if (threads.length === 0) {
    return null;
  }
  return (
    <AgentCommandSection label="Chats" className="pb-3">
      {threads.map((thread) => {
        return (
          <ChatThreadCommandItem
            key={thread.id}
            thread={thread}
            hasUnread={
              unreadIndicatorsEnabled && setHasId(unreadThreadIds, thread.id)
            }
            onSelect={() => {
              return onSelect(thread.id);
            }}
          />
        );
      })}
    </AgentCommandSection>
  );
}

function AgentDialogEmptyStates({
  subagents,
  showAgentEmpty,
  showCombinedEmpty,
}: {
  readonly subagents: readonly SubagentInfo[];
  readonly showAgentEmpty: boolean;
  readonly showCombinedEmpty: boolean;
}) {
  return (
    <>
      {subagents.length === 0 && (
        <div className="px-5 pb-5">
          <p className="text-xs text-muted-foreground px-1 py-2">
            No sub-agents available yet.
          </p>
        </div>
      )}
      {showAgentEmpty && (
        <div className="px-5 pb-5">
          <p className="text-xs text-muted-foreground px-1 py-2">
            No agents found
          </p>
        </div>
      )}
      {showCombinedEmpty && (
        <div className="px-5 pb-5">
          <p className="text-xs text-muted-foreground px-1 py-2">
            No results found
          </p>
        </div>
      )}
    </>
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
  const zeroAvatarUrl = useLastResolved(leadAgentAvatarUrl$) ?? null;
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const features = useGet(featureSwitch$);
  const unreadIndicatorsEnabled =
    features[FeatureSwitchKey.AgentUnreadIndicators] ?? false;
  const chatThreadUnifiedSearchEnabled =
    features[FeatureSwitchKey.ChatThreadUnifiedSearch] ?? false;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
  const unreadThreadIds = useLastResolved(sidebarUnreadThreadIds$);
  const allChatThreads = useLastResolved(allChatThreadListItems$) ?? [];
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
  const matchingChatThreads = filterChatThreadDialogItems({
    enabled: chatThreadUnifiedSearchEnabled,
    threads: allChatThreads,
    trimmedQuery,
  });

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

  const hasAgentMatches =
    showLead || filteredPinned.length > 0 || filteredUnpinned.length > 0;
  const hasChatThreadMatches = matchingChatThreads.length > 0;
  const showAgentEmpty =
    trimmedQuery && !hasAgentMatches && !chatThreadUnifiedSearchEnabled;
  const showCombinedEmpty =
    chatThreadUnifiedSearchEnabled &&
    trimmedQuery &&
    !hasAgentMatches &&
    !hasChatThreadMatches;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="zero-app sm:max-w-xl w-[calc(100vw-2rem)] gap-0"
      commandClassName="gap-0"
      commandProps={{ shouldFilter: false, loop: true }}
    >
      <DialogHeader className="px-5 pt-5 pb-3">
        <DialogTitle className="text-base font-semibold">Talk to</DialogTitle>
        <DialogDescription className="text-sm text-muted-foreground mt-1">
          {agentListDialogDescription(chatThreadUnifiedSearchEnabled)}
        </DialogDescription>
      </DialogHeader>

      <AgentCommandSearch
        query={query}
        setQuery={setQuery}
        placeholder={agentListDialogSearchPlaceholder(
          chatThreadUnifiedSearchEnabled,
        )}
      />

      <CommandList>
        <LeadAgentCommandSection
          displayName={displayName}
          show={showLead}
          zeroAvatarUrl={zeroAvatarUrl}
          unreadIndicatorsEnabled={unreadIndicatorsEnabled}
          defaultAgentId={defaultAgentId}
          unreadAgentIds={unreadAgentIds}
          onChat={() => {
            return handleChat(null);
          }}
        />
        <PinnedAgentsCommandSection
          agents={filteredPinned}
          disabled={saving}
          unreadIndicatorsEnabled={unreadIndicatorsEnabled}
          unreadAgentIds={unreadAgentIds}
          onChat={handleChat}
          onTogglePin={togglePin}
        />
        <UnpinnedAgentsCommandSection
          agents={filteredUnpinned}
          disabled={saving}
          unreadIndicatorsEnabled={unreadIndicatorsEnabled}
          unreadAgentIds={unreadAgentIds}
          onChat={handleChat}
          onTogglePin={togglePin}
        />
        <ChatThreadCommandSection
          threads={matchingChatThreads}
          unreadIndicatorsEnabled={unreadIndicatorsEnabled}
          unreadThreadIds={unreadThreadIds}
          onSelect={handleChatThread}
        />
        <AgentDialogEmptyStates
          subagents={subagents}
          showAgentEmpty={Boolean(showAgentEmpty)}
          showCombinedEmpty={Boolean(showCombinedEmpty)}
        />
      </CommandList>
    </CommandDialog>
  );
}
