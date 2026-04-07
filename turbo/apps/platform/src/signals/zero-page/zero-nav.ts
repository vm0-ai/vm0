import { command, computed, state } from "ccstate";
import { detachedNavigateTo$, pathParams$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { activeRoute$ } from "../active-route.ts";
import { localStorageSignals } from "../external/local-storage.ts";

/** Re-export activeRoute$ for consumers that used to import zeroActiveId$ */
export { activeRoute$ } from "../active-route.ts";

/**
 * Chat thread ID extracted from `/chats/:id`.
 * Returns null when on `/`, or `/agents/:id/chat`.
 */
export const chatThreadId$ = computed((get): string | null => {
  const params = get(pathParams$);
  const id = params?.id;
  const route = get(activeRoute$);
  // Only return the id when we're on the chat route
  if (route !== "chat") {
    return null;
  }
  return typeof id === "string" ? id : null;
});

/**
 * Navigate to a specific chat session — `/chats/:id`.
 *
 * Always performs a full route navigation so that `loadRoute$` fires and
 * the correct page setup runs (e.g. when navigating from /agents).
 * `loadInitialData$` guards heavy work behind `initialDataLoaded$`, so
 * re-entry from an already-loaded zero page is cheap.
 */
export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:id", {
    pathParams: { id: chatThreadId },
  });
});

// ---------------------------------------------------------------------------
// Shell UI state — sidebar chat agent, about page, sidebar collapse
// ---------------------------------------------------------------------------

/**
 * In-memory state tracking which agent the sidebar displays.
 * Written by page setup commands when entering /agents/:id/chat or /chats/:id.
 * Persists across navigations to non-chat pages (e.g. /activities) so the sidebar
 * "remembers" the last visited agent.
 * Null means default agent.
 */
const internalSidebarChatAgentId$ = state<string | null>(null);

/** Currently displayed sidebar chat agent ID. Null = default agent. */
export const sidebarChatAgentId$ = computed((get): string | null => {
  return get(internalSidebarChatAgentId$);
});

/** Set the sidebar chat agent ID. Called by page setup commands. */
export const setSidebarChatAgent$ = command(
  ({ set }, agentId: string | null) => {
    set(internalSidebarChatAgentId$, agentId);
  },
);

const internalShowAboutPage$ = state(false);

/** Whether the About VM0 page is shown. */
export const zeroShowAboutPage$ = computed((get) => {
  return get(internalShowAboutPage$);
});

/** Show or hide the About VM0 page. */
export const setZeroShowAboutPage$ = command(({ set }, show: boolean) => {
  set(internalShowAboutPage$, show);
});

// ---------------------------------------------------------------------------
// Sidebar visibility — two independent states, no JS viewport detection
// ---------------------------------------------------------------------------

const {
  get$: sidebarOffRaw$,
  set$: setSidebarOffRaw$,
  clear$: clearSidebarOff$,
} = localStorageSignals("sidebarOff");

/** Whether the user has turned off the sidebar on desktop. Persisted. */
export const sidebarOff$ = computed((get) => {
  return get(sidebarOffRaw$) !== null;
});

/** Toggle sidebar off/on for desktop. Persisted in localStorage. */
export const toggleSidebarOff$ = command(({ get, set }) => {
  if (get(sidebarOffRaw$) !== null) {
    set(clearSidebarOff$);
  } else {
    set(setSidebarOffRaw$, "1");
  }
});

const internalSidebarExpanded$ = state(false);

/** Whether the mobile sidebar overlay is expanded. In-memory only. */
export const sidebarExpanded$ = computed((get) => {
  return get(internalSidebarExpanded$);
});

/** Set mobile sidebar expanded state. */
export const setSidebarExpanded$ = command(({ set }, expanded: boolean) => {
  set(internalSidebarExpanded$, expanded);
});

// ---------------------------------------------------------------------------
// Shell commands — nav select, account action, send from demo
// ---------------------------------------------------------------------------

/** Nav item identifiers used by the sidebar. */
export type SidebarNavId =
  | "chat"
  | "agents"
  | "connectors"
  | "schedules"
  | "activities"
  | "works"
  | "settings"
  | "settingsUsage"
  | "queues"
  | "lab";

/** Check if a route key corresponds to the chat section. */
export function isChatRoute(key: RouteKey | null): boolean {
  return (
    key === "home" ||
    key === "agentChat" ||
    key === "agentIdeas" ||
    key === "chat"
  );
}

/** Handle nav tab selection: navigate to tab and close about page. */
export const handleZeroNavSelect$ = command(({ set }, id: SidebarNavId) => {
  if (id === "chat") {
    set(detachedNavigateTo$, "/");
  } else if (id === "agents") {
    set(detachedNavigateTo$, ROUTES.agents);
  } else if (id === "connectors") {
    set(detachedNavigateTo$, ROUTES.connectors);
  } else if (id === "schedules") {
    set(detachedNavigateTo$, ROUTES.schedules);
  } else if (id === "activities") {
    set(detachedNavigateTo$, ROUTES.activities);
  } else if (id === "works") {
    set(detachedNavigateTo$, ROUTES.works);
  } else if (id === "settings") {
    set(detachedNavigateTo$, ROUTES.settings);
  } else if (id === "settingsUsage") {
    set(detachedNavigateTo$, ROUTES.settingsUsage);
  } else if (id === "queues") {
    set(detachedNavigateTo$, ROUTES.queues);
  } else if (id === "lab") {
    set(detachedNavigateTo$, ROUTES.lab);
  }
  set(internalShowAboutPage$, false);
});

export type ZeroAccountAction = "preferences" | "manage" | "signout";

/** Handle account menu action. */
export const handleZeroAccountAction$ = command(
  ({ set }, action: ZeroAccountAction) => {
    if (action === "signout" || action === "manage") {
      return;
    }
    if (action === "preferences") {
      set(detachedNavigateTo$, ROUTES.settings);
    }
  },
);
