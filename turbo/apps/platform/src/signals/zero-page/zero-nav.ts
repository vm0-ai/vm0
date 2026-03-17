import { command, computed, state } from "ccstate";
import { pathname$, updatePathname$ } from "../route.ts";
import type { ZeroNavId } from "../../views/zero-page/zero-sidebar.tsx";

function isValidTab(tab: string): tab is ZeroNavId {
  return (
    tab === "chat" ||
    tab === "schedule" ||
    tab === "team" ||
    tab === "activity" ||
    tab === "works" ||
    tab === "settings" ||
    tab === "preferences"
  );
}

/**
 * Active zero nav id, derived from the URL path `/:tab`.
 * `/`, `/chat`, `/chat/:sessionId`, and `/talk/:name`
 * all resolve to "chat".
 */
export const zeroActiveId$ = computed((get): ZeroNavId => {
  const path = get(pathname$);
  const segment = path.split("/")[1] ?? "";
  if (segment && isValidTab(segment)) {
    return segment;
  }
  return "chat";
});

/**
 * Whether the user is on a chat session page — `/chat` or `/chat/:sessionId`.
 */
export const zeroInChat$ = computed((get): boolean => {
  const path = get(pathname$);
  return /^\/chat(\/|$)/.test(path);
});

/**
 * Session ID extracted from `/chat/:sessionId`.
 * Returns null when on `/`, `/chat`, or `/talk/:name`.
 */
export const zeroSessionId$ = computed((get): string | null => {
  const path = get(pathname$);
  const match = /^\/chat\/([^/]+)$/.exec(path);
  return match ? match[1] : null;
});

/**
 * Agent name extracted from `/talk/:name`.
 * Returns null when chatting with the default agent.
 */
export const zeroChatAgentName$ = computed((get): string | null => {
  const path = get(pathname$);
  const match = /^\/talk\/([^/]+)/.exec(path);
  return match ? decodeURIComponent(match[1]) : null;
});

/**
 * In-memory state tracking the current chat agent ID.
 * Null means default agent. Set when navigating to a chat route.
 */
const internalChatAgentId$ = state<string | null>(null);

/**
 * Currently selected chat agent ID (in-memory).
 * Returns null when chatting with the default/main agent.
 */
export const zeroChatAgentId$ = computed((get): string | null => {
  return get(internalChatAgentId$);
});

/**
 * Last chat agent name, preserved across non-chat navigation.
 * Used to maintain recent chat context when visiting schedule/team pages,
 * and to navigate back from sessions to the correct talk route.
 */
const internalLastChatAgentName$ = state<string | null>(null);

/**
 * Navigate to a zero tab — updates the URL path to `/:tab`.
 * "chat" maps to `/` (the default, no suffix needed).
 */
export const setZeroActiveId$ = command(({ set }, id: ZeroNavId) => {
  const newPath = id === "chat" ? "/" : `/${id}`;
  set(updatePathname$, newPath);
});

/**
 * Whether the talk agent has been resolved from the URL.
 * Set to true after setupZeroPage$ processes the /zero/talk/:name route.
 */
const internalTalkAgentResolved$ = state(false);
export const zeroTalkAgentResolved$ = computed((get) =>
  get(internalTalkAgentResolved$),
);

/**
 * Set the chat agent ID and name (in-memory).
 * Pass null to clear (chat with default agent).
 */
export const setZeroChatAgent$ = command(
  ({ set }, agent: { id: string; name: string } | null) => {
    set(internalChatAgentId$, agent?.id ?? null);
    set(internalLastChatAgentName$, agent?.name ?? null);
    set(internalTalkAgentResolved$, true);
  },
);

/**
 * Sub-path segment under the current tab, e.g. `/activity/:sub`.
 * Returns null when there is no sub-segment.
 */
export const zeroTabSub$ = computed((get): string | null => {
  const path = get(pathname$);
  const parts = path.split("/");
  return parts[2] || null;
});

/**
 * Navigate to a specific chat session — `/chat/:sessionId`.
 */
export const navigateToZeroSession$ = command(({ set }, sessionId: string) => {
  set(updatePathname$, `/chat/${sessionId}`);
});

/**
 * Navigate back from a chat session to the chat home.
 * Returns to `/talk/:name` if a team agent was selected, otherwise `/`.
 */
export const navigateFromZeroSession$ = command(({ get, set }) => {
  const agentName = get(internalLastChatAgentName$);
  if (agentName) {
    set(updatePathname$, `/talk/${encodeURIComponent(agentName)}`);
  } else {
    set(updatePathname$, "/");
  }
});
