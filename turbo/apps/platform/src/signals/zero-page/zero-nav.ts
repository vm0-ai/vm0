import { command, computed, state } from "ccstate";
import { pathname$, detachedNavigateTo$, pathParams$ } from "../route.ts";
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
 * `/`, `/chat`, `/chat/:chatThreadId`, and `/talk/:agentId`
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
 * Chat thread ID extracted from `/chat/:chatThreadId`.
 * Returns null when on `/`, `/chat`, or `/talk/:agentId`.
 */
export const chatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const chatThreadId = params?.chatThreadId;
  return typeof chatThreadId === "string" ? chatThreadId : null;
});

/**
 * Agent ID extracted from `/talk/:agentId`.
 * Returns null when chatting with the default agent.
 */
export const zeroTalkAgentId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const agentId = params?.agentId;
  return typeof agentId === "string" ? agentId : null;
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
 * Navigate to a specific chat session — `/chat/:chatThreadId`.
 *
 * Always performs a full route navigation so that `loadRoute$` fires and
 * the correct page setup runs (e.g. when navigating from /team).
 * `loadInitialData$` guards heavy work behind `initialDataLoaded$`, so
 * re-entry from an already-loaded zero page is cheap.
 */
export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chat/:chatThreadId", {
    pathParams: { chatThreadId },
  });
});

// ---------------------------------------------------------------------------
// Shell UI state — about page, sidebar
// ---------------------------------------------------------------------------

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
  if (id === "chat") {
    set(detachedNavigateTo$, "/");
  } else if (id === "team") {
    set(detachedNavigateTo$, "/team");
  } else {
    set(detachedNavigateTo$, "/:tab", { pathParams: { tab: id } });
  }
  set(internalShowAboutPage$, false);
});

/** Handle account menu action. */
export const handleZeroAccountAction$ = command(
  ({ set }, action: ZeroAccountAction) => {
    if (action === "signout" || action === "manage") {
      return;
    }
    if (action === "preferences") {
      set(detachedNavigateTo$, "/:tab", { pathParams: { tab: "preferences" } });
    }
  },
);
