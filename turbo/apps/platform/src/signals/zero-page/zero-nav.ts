import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { setChatShortcutHelpOpen$ } from "../chat-page/chat-shortcut-help.ts";
import { openAgentListDialog$ } from "./zero-sidebar-state.ts";

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
        "mod+b": {
          allowInEditableTarget: true,
          run: () => {
            set(toggleSidebarOff$);
          },
        },
        "mod+shift+o": {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateToNewChat$, signal);
          },
        },
        "mod+shift+a": {
          allowInEditableTarget: true,
          run: () => {
            set(openAgentListDialog$);
          },
        },
        "shift+/": {
          run: () => {
            set(setChatShortcutHelpOpen$, true);
          },
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
  | "memory"
  | "connectors"
  | "automations"
  | "workflows"
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
        memory: ROUTES.memory,
        connectors: ROUTES.connectors,
        automations: ROUTES.automations,
        workflows: ROUTES.workflows,
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
