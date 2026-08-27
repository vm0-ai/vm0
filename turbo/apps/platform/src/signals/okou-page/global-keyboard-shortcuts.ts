import { command } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { activeRoute$ } from "../active-route.ts";
import { currentChatAgentId$ } from "../agent-chat.ts";
import { eventDrivenChatThreads$ } from "../chat-page/chat-thread-event-sourcing.ts";
import { setChatShortcutHelpOpen$ } from "../chat-page/chat-shortcut-help.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { detachedNavigateTo$ } from "../route.ts";
import { isStandaloneMode } from "../standalone-mode.ts";
import { navigateToChat$, toggleSidebarOff$ } from "./nav.ts";
import { displayedPinnedAgents$ } from "./pinned-agents.ts";
import {
  openAgentListDialog$,
  openThreeColumnSearchDialog$,
} from "./sidebar-state.ts";
import { writeToClipboard } from "./clipboard.ts";

type PinnedAgentShortcutDirection = "prev" | "next";

const navigateToNewChat$ = command(
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
  pinnedAgents: readonly { readonly agentId: string }[],
  currentAgentId: string | null,
  direction: PinnedAgentShortcutDirection,
): string | null {
  if (pinnedAgents.length === 0) {
    return null;
  }
  const currentIndex = currentAgentId
    ? pinnedAgents.findIndex((agent) => {
        return agent.agentId === currentAgentId;
      })
    : -1;
  if (currentIndex === -1) {
    return direction === "next"
      ? pinnedAgents[0]!.agentId
      : pinnedAgents[pinnedAgents.length - 1]!.agentId;
  }
  const offset = direction === "next" ? 1 : -1;
  return pinnedAgents[
    (currentIndex + offset + pinnedAgents.length) % pinnedAgents.length
  ]!.agentId;
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

const navigateAdjacentPinnedAgent$ = command(
  async (
    { get, set },
    direction: PinnedAgentShortcutDirection,
    signal: AbortSignal,
  ) => {
    const currentAgentId = await get(currentChatAgentId$);
    signal.throwIfAborted();
    const targetAgentId = adjacentPinnedAgentId(
      await get(displayedPinnedAgents$),
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

export const setupGlobalKeyboardShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        "mod+b": {
          allowInEditableTarget: true,
          run: () => {
            set(toggleSidebarOff$);
          },
        },
        "mod+k": {
          allowInEditableTarget: true,
          shouldHandle: () => {
            return (
              get(featureSwitch$)[FeatureSwitchKey.ThreeColumnNav] ?? false
            );
          },
          run: () => {
            set(openThreeColumnSearchDialog$);
          },
        },
        "mod+l": {
          allowInEditableTarget: true,
          shouldHandle: () => {
            return isStandaloneMode();
          },
          run: async () => {
            await writeToClipboard(window.location.href);
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
