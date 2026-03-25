import { command, computed, state } from "ccstate";
import { pathname$, navigateTo$ } from "../route.ts";
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
    tab === "preferences" ||
    tab === "queue"
  );
}

/**
 * Active zero nav id, derived from the URL path `/:tab`.
 * `/`, `/chat`, `/chat/:sessionId`, and `/talk/:id`
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
 * Session ID extracted from `/chat/:sessionId`.
 * Returns null when on `/`, `/chat`, or `/talk/:id`.
 */
export const zeroSessionId$ = computed((get): string | null => {
  const path = get(pathname$);
  const match = /^\/chat\/([^/]+)$/.exec(path);
  return match ? match[1] : null;
});

/**
 * Agent ID extracted from `/talk/:id`.
 * Returns null when chatting with the default agent.
 */
export const zeroTalkAgentId$ = computed((get): string | null => {
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
    set(navigateTo$, "/");
  } else if (id === "team") {
    set(navigateTo$, "/team");
  } else {
    set(navigateTo$, "/:tab", { pathParams: { tab: id } });
  }
});

const internalTalkAgentResolved$ = state(false);

/**
 * Set the chat agent ID (in-memory).
 * Pass null to clear (chat with default agent).
 */
export const setZeroChatAgent$ = command(({ set }, agentId: string | null) => {
  set(internalChatAgentId$, agentId);
  set(internalTalkAgentResolved$, true);
});

/**
 * Navigate to a specific chat session — `/chat/:sessionId`.
 *
 * Always performs a full route navigation so that `loadRoute$` fires and
 * the correct page setup runs (e.g. when navigating from /team).
 * `loadInitialData$` guards heavy work behind `initialDataLoaded$`, so
 * re-entry from an already-loaded zero page is cheap.
 */
export const navigateToZeroSession$ = command(({ set }, sessionId: string) => {
  set(navigateTo$, "/chat/:sessionId", { pathParams: { sessionId } });
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
