import { command, computed, state } from "ccstate";
import { detachedNavigateTo$ } from "../route.ts";
import { ROUTES, type RouteKey } from "../route-paths.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { openQueueDrawer$ } from "../queue-page/queue-drawer-state.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { activeRoute$ } from "../active-route.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { setChatShortcutHelpOpen$ } from "../chat-page/chat-shortcut-help.ts";
import { openAgentListDialog$ } from "./zero-sidebar-state.ts";
import { pinnedAgents$ } from "./zero-pinned-agents.ts";

type PinnedAgentShortcutDirection = "prev" | "next";

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

function adjacentPinnedAgentId(
  pinnedAgents: readonly { readonly id: string }[],
  currentAgentId: string | null,
  direction: PinnedAgentShortcutDirection,
): string | null {
  if (pinnedAgents.length === 0) {
    return null;
  }
  const currentIndex = currentAgentId
    ? pinnedAgents.findIndex((agent) => {
        return agent.id === currentAgentId;
      })
    : -1;
  if (currentIndex === -1) {
    return direction === "next"
      ? pinnedAgents[0]!.id
      : pinnedAgents[pinnedAgents.length - 1]!.id;
  }
  const offset = direction === "next" ? 1 : -1;
  return pinnedAgents[
    (currentIndex + offset + pinnedAgents.length) % pinnedAgents.length
  ]!.id;
}

const firstChatThreadIdForAgent$ = command(
  async ({ get }, agentId: string, signal: AbortSignal) => {
    const threads = await get(eventDrivenChatThreads$);
    signal.throwIfAborted();
    for (const thread of threads) {
      if (thread.agentId === agentId) {
        return thread.id;
      }
    }
    return null;
  },
);

const navigateToAgentChat$ = command(({ set }, agentId: string) => {
  set(detachedNavigateTo$, "/agents/:agentId/chat", {
    pathParams: { agentId },
  });
});

const navigateToPinnedAgent$ = command(
  async ({ get, set }, agentId: string, signal: AbortSignal) => {
    if (get(activeRoute$) === "chat") {
      const threadId = await set(firstChatThreadIdForAgent$, agentId, signal);
      signal.throwIfAborted();
      if (threadId) {
        set(navigateToChat$, threadId);
        return;
      }
    }
    set(navigateToAgentChat$, agentId);
  },
);

export const navigateAdjacentPinnedAgent$ = command(
  async (
    { get, set },
    direction: PinnedAgentShortcutDirection,
    signal: AbortSignal,
  ) => {
    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const targetAgentId = adjacentPinnedAgentId(
      await get(pinnedAgents$),
      currentAgentId,
      direction,
    );
    signal.throwIfAborted();
    if (!targetAgentId) {
      return;
    }
    await set(navigateToPinnedAgent$, targetAgentId, signal);
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
        "ctrl+shift+[": {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateAdjacentPinnedAgent$, "prev", signal);
          },
        },
        "ctrl+shift+]": {
          allowInEditableTarget: true,
          run: async () => {
            await set(navigateAdjacentPinnedAgent$, "next", signal);
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
