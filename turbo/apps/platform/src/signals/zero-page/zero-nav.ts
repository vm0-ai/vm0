import { command, computed, state } from "ccstate";
import { pathname$, navigateInReact$ } from "../route.ts";
import type {
  ZeroNavId,
  ZeroAccountAction,
} from "../../views/zero-page/zero-sidebar.tsx";

function isValidTab(tab: string): tab is ZeroNavId {
  return (
    tab === "chat" ||
    tab === "schedule" ||
    tab === "team" ||
    tab === "activity" ||
    tab === "works" ||
    tab === "usage" ||
    tab === "settings" ||
    tab === "preferences" ||
    tab === "queue"
  );
}

/**
 * Active zero nav id, derived from the URL path `/:tab`.
 * `/`, `/chat`, `/chat/:sessionId`, and `/talk/:name`
 * all resolve to "chat".
 * Unknown paths resolve to "not-found".
 */
export const zeroActiveId$ = computed((get): ZeroNavId => {
  const path = get(pathname$);
  const segment = path.split("/")[1] ?? "";
  if (!segment || segment === "talk") {
    return "chat";
  }
  if (isValidTab(segment)) {
    return segment;
  }
  return "not-found";
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
 * Navigate to a zero tab — updates the URL path to `/:tab`.
 * "chat" maps to `/` (the default, no suffix needed).
 * "team" maps to `/team` (dedicated route).
 */
export const setZeroActiveId$ = command(({ set }, id: ZeroNavId) => {
  if (id === "chat") {
    set(navigateInReact$, "/");
  } else if (id === "team") {
    set(navigateInReact$, "/team");
  } else {
    set(navigateInReact$, "/:tab", { pathParams: { tab: id } });
  }
});

/**
 * Whether the talk agent has been resolved from the URL.
 * Set to true after setupTalkPage$ processes the /talk/:name route.
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
    set(internalTalkAgentResolved$, true);
  },
);

/**
 * Navigate to a specific chat session — `/chat/:sessionId`.
 *
 * Always performs a full route navigation so that `loadRoute$` fires and
 * the correct page setup runs (e.g. when navigating from /team).
 * `loadInitialData$` guards heavy work behind `initialDataLoaded$`, so
 * re-entry from an already-loaded zero page is cheap.
 */
export const navigateToZeroSession$ = command(({ set }, sessionId: string) => {
  set(navigateInReact$, "/chat/:sessionId", { pathParams: { sessionId } });
});

/**
 * Navigate back from a chat session to the previous route in browser history.
 */
export const navigateFromZeroSession$ = command(() => {
  window.history.back();
});

// ---------------------------------------------------------------------------
// Shell UI state — avatar, about page, sidebar
// ---------------------------------------------------------------------------

const internalAvatarIndex$ = state(0);

/** Current avatar index for the Zero agent avatar cycle. */
export const zeroAvatarIndex$ = computed((get) => get(internalAvatarIndex$));

/** Advance the avatar to the next image in the cycle. */
export const cycleZeroAvatar$ = command(({ get, set }, avatarCount: number) => {
  const current = get(internalAvatarIndex$);
  set(internalAvatarIndex$, (current + 1) % avatarCount);
});

const internalShowAboutPage$ = state(false);

/** Whether the About VM0 page is shown. */
export const zeroShowAboutPage$ = computed((get) =>
  get(internalShowAboutPage$),
);

/** Show or hide the About VM0 page. */
export const setZeroShowAboutPage$ = command(({ set }, show: boolean) => {
  set(internalShowAboutPage$, show);
});

const internalSidebarCollapsed$ = state(false);

/** Whether the sidebar is collapsed. */
export const zeroSidebarCollapsed$ = computed((get) =>
  get(internalSidebarCollapsed$),
);

/** Set sidebar collapsed state. */
export const setZeroSidebarCollapsed$ = command(
  ({ set }, collapsed: boolean) => {
    set(internalSidebarCollapsed$, collapsed);
  },
);

/** Initialize sidebar collapsed state from viewport width. */
export const initSidebarCollapsed$ = command(({ set }) => {
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;
  set(internalSidebarCollapsed$, isMobile);
});

// ---------------------------------------------------------------------------
// Shell commands — nav select, account action, send from demo
// ---------------------------------------------------------------------------

/** Handle nav tab selection: navigate to tab and close about page. */
export const handleZeroNavSelect$ = command(({ set }, id: ZeroNavId) => {
  set(setZeroActiveId$, id);
  set(internalShowAboutPage$, false);
});

/** Handle account menu action. */
export const handleZeroAccountAction$ = command(
  ({ set }, action: ZeroAccountAction) => {
    if (action === "signout" || action === "manage") {
      return;
    }
    if (action === "preferences") {
      set(setZeroActiveId$, "preferences");
    }
  },
);
