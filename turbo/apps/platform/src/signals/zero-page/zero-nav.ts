import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";

export const navigateToChat$ = command(({ set }, chatThreadId: string) => {
  set(detachedNavigateTo$, "/chats/:threadId", {
    pathParams: { threadId: chatThreadId },
  });
});

export const navigateToNewChat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const agentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    if (!agentId) {
      return;
    }
    set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId },
    });
  },
);

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

export const setupGlobalKeyboardShortcuts$ = command(
  ({ set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        "mod+b": () => {
          set(toggleSidebarOff$);
        },
        "mod+shift+o": async () => {
          await set(navigateToNewChat$, signal);
        },
      },
      signal,
    );
  },
);

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
  | "skills"
  | "memory"
  | "connectors"
  | "schedules"
  | "activities"
  | "insights"
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

export const handleZeroNavSelect$ = command(
  ({ set }, id: SidebarNavId, signal: AbortSignal) => {
    if (id === "queues") {
      set(openQueueDrawer$, signal);
    } else {
      const navRoutes = {
        chat: ROUTES.home,
        agents: ROUTES.agents,
        skills: ROUTES.skills,
        memory: ROUTES.memory,
        connectors: ROUTES.connectors,
        schedules: ROUTES.schedules,
        activities: ROUTES.activities,
        insights: ROUTES.insights,
        works: ROUTES.works,
        settings: ROUTES.settings,
      } satisfies Record<
        Exclude<SidebarNavId, "queues">,
        (typeof ROUTES)[keyof typeof ROUTES]
      >;
      set(detachedNavigateTo$, navRoutes[id]);
    }
    set(internalShowAboutPage$, false);
  },
);

export type ZeroAccountAction = "lab" | "signout";

export const handleZeroAccountAction$ = command(
  ({ set }, action: ZeroAccountAction) => {
    set(internalSidebarExpanded$, false);
    if (action === "lab") {
      set(detachedNavigateTo$, ROUTES.lab);
    }
  },
);
