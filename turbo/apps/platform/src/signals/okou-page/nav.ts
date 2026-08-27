import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";

export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:threadId", {
    pathParams: { threadId: chatThreadId },
  });
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
  | "artifacts"
  | "connectors"
  | "workflows"
  | "works"
  | "settings"
  | "queues";

export function isChatRoute(key: RouteKey | null): boolean {
  return (
    key === "home" ||
    key === "agentChat" ||
    key === "agentIdeas" ||
    key === "chat"
  );
}

export const handleNavSelect$ = command(({ set }, id: SidebarNavId) => {
  if (id === "queues") {
    set(openQueueDrawer$);
  } else {
    const navRoutes = {
      chat: ROUTES.home,
      agents: ROUTES.agents,
      artifacts: ROUTES.artifacts,
      connectors: ROUTES.connectors,
      workflows: ROUTES.workflows,
      works: ROUTES.works,
      settings: ROUTES.settings,
    } satisfies Record<
      Exclude<SidebarNavId, "queues">,
      (typeof ROUTES)[keyof typeof ROUTES]
    >;
    set(detachedNavigateTo$, navRoutes[id]);
  }
});

export type AccountAction = "lab" | "signout";

export const handleAccountAction$ = command(
  ({ set }, action: AccountAction) => {
    set(internalSidebarExpanded$, false);
    if (action === "lab") {
      set(detachedNavigateTo$, ROUTES.lab);
    }
  },
);
