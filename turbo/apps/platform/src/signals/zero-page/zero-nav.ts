import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";

export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:id", {
    pathParams: { id: chatThreadId },
  });
});

const internalShowAboutPage$ = state(false);

export const zeroShowAboutPage$ = computed((get) => {
  return get(internalShowAboutPage$);
});

export const setZeroShowAboutPage$ = command(({ set }, show: boolean) => {
  set(internalShowAboutPage$, show);
});

const {
  get$: sidebarOffRaw$,
  set$: setSidebarOffRaw$,
  clear$: clearSidebarOff$,
} = localStorageSignals("sidebarOff");

export const sidebarOff$ = computed((get) => {
  return get(sidebarOffRaw$) !== null;
});

export const toggleSidebarOff$ = command(({ get, set }) => {
  if (get(sidebarOffRaw$) !== null) {
    set(clearSidebarOff$);
  } else {
    set(setSidebarOffRaw$, "1");
  }
});

const internalSidebarExpanded$ = state(false);

export const sidebarExpanded$ = computed((get) => {
  return get(internalSidebarExpanded$);
});

export const setSidebarExpanded$ = command(({ set }, expanded: boolean) => {
  set(internalSidebarExpanded$, expanded);
});

export type SidebarNavId =
  | "chat"
  | "agents"
  | "connectors"
  | "schedules"
  | "activities"
  | "insights"
  | "works"
  | "settings"
  | "settingsUsage"
  | "queues"
  | "lab";

export function isChatRoute(key: RouteKey | null): boolean {
  return (
    key === "home" ||
    key === "agentChat" ||
    key === "agentIdeas" ||
    key === "chat"
  );
}

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
  } else if (id === "insights") {
    set(detachedNavigateTo$, ROUTES.insights);
  } else if (id === "works") {
    set(detachedNavigateTo$, ROUTES.works);
  } else if (id === "settings") {
    set(detachedNavigateTo$, ROUTES.settings);
  } else if (id === "settingsUsage") {
    set(detachedNavigateTo$, ROUTES.settingsUsage);
  } else if (id === "queues") {
    set(openQueueDrawer$);
  } else if (id === "lab") {
    set(detachedNavigateTo$, ROUTES.lab);
  }
  set(internalShowAboutPage$, false);
});

export type ZeroAccountAction = "preferences" | "manage" | "signout";

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
