import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";

/** Re-export activeRoute$ for consumers that used to import zeroActiveId$ */
export { activeRoute$ } from "../active-route.ts";

/**
 * Re-export from centralized agent signals for backward compatibility.
 * Prefer importing `currentChatThreadId$` from `../agent.ts`.
 */
export { currentChatThreadId$ as chatThreadId$ } from "../agent.ts";

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
  | "queues";

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
