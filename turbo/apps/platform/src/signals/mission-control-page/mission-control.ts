import { command, computed, state } from "ccstate";
import { matchShortcut } from "@vm0/ui";
import {
  activePanelId$,
  toggleMaximizeTask$,
  toggleTaskList$,
} from "./mission-control-panels.ts";
import {
  addOptimisticTask$,
  archiveAndFocusNext$,
  closeAndFocusNextInput$,
  focusTaskCard$,
  setupTasksLoop$,
} from "./mission-control-tasks.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { onDomEventFn, onRef, throwIfNotAbort } from "../utils.ts";
import { agents$ } from "../agent.ts";
import { zeroOnboardingStatus$ } from "../zero-page/zero-onboarding.ts";
import { createNewChatThread$ } from "../chat-page/chat-message.ts";

// ---------------------------------------------------------------------------
// Task list container ref
// ---------------------------------------------------------------------------

const internalTaskListRef$ = state<HTMLElement | null>(null);

export const setTaskListRef$ = onRef(
  command(({ set }, el: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(internalTaskListRef$, null);
    });
    set(internalTaskListRef$, el);
  }),
);

// ---------------------------------------------------------------------------
// DOM-based task list navigation
// ---------------------------------------------------------------------------

function isFullyVisible(card: Element, container: Element): boolean {
  const cr = card.getBoundingClientRect();
  const vr = container.getBoundingClientRect();
  return cr.top >= vr.top && cr.bottom <= vr.bottom;
}

const navigateTaskList$ = command(({ get }, direction: "next" | "prev") => {
  const container = get(internalTaskListRef$);
  if (!container) {
    return;
  }

  const cards = Array.from(
    container.querySelectorAll<HTMLElement>("[tabindex='0']"),
  );
  if (cards.length === 0) {
    return;
  }

  const active = document.activeElement;
  const currentIndex = active ? cards.indexOf(active as HTMLElement) : -1;

  let target: HTMLElement | undefined;

  if (currentIndex !== -1) {
    // Already focused on a card — move to sibling, clamp at boundary
    if (direction === "next" && currentIndex < cards.length - 1) {
      target = cards[currentIndex + 1];
    } else if (direction === "prev" && currentIndex > 0) {
      target = cards[currentIndex - 1];
    }
  } else {
    // No card focused — pick first/last fully visible
    if (direction === "next") {
      target = cards.find((c) => {
        return isFullyVisible(c, container);
      });
    } else {
      for (let i = cards.length - 1; i >= 0; i--) {
        if (isFullyVisible(cards[i], container)) {
          target = cards[i];
          break;
        }
      }
    }
    // Fallback: first or last card if none fully visible
    target ??= direction === "next" ? cards[0] : cards[cards.length - 1];
  }

  if (target) {
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  }
});

// ---------------------------------------------------------------------------
// New chat dialog state
// ---------------------------------------------------------------------------

const internalNewChatDialogOpen$ = state(false);
export const newChatDialogOpen$ = computed((get) => {
  return get(internalNewChatDialogOpen$);
});
export const setNewChatDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalNewChatDialogOpen$, open);
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts help dialog state
// ---------------------------------------------------------------------------

const internalShortcutHelpOpen$ = state(false);
export const shortcutHelpOpen$ = computed((get) => {
  return get(internalShortcutHelpOpen$);
});
export const setShortcutHelpOpen$ = command(({ set }, open: boolean) => {
  set(internalShortcutHelpOpen$, open);
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

export const setupMissionControlKeyboard$ = command(
  ({ get, set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      {
        k: () => {
          set(navigateTaskList$, "prev");
        },
        j: () => {
          set(navigateTaskList$, "next");
        },
        "mod+b": () => {
          set(toggleTaskList$);
        },
        c: () => {
          set(setNewChatDialogOpen$, true);
        },
        "shift+?": () => {
          set(setShortcutHelpOpen$, true);
        },
        y: () => {
          const container = get(internalTaskListRef$);
          if (!container) {
            return;
          }
          const active = document.activeElement as HTMLElement | null;
          if (!active) {
            return;
          }
          const taskId = active.dataset.taskId;
          if (taskId) {
            void set(archiveAndFocusNext$, taskId, signal).catch(
              throwIfNotAbort,
            );
          }
        },
      },
      signal,
    );

    // Panel shortcuts — work from any context (including editable targets),
    // targeting the active panel. Skipped if already handled by the panel's
    // own onKeyDown (detected via e.defaultPrevented).
    document.addEventListener(
      "keydown",
      onDomEventFn(async (e: KeyboardEvent) => {
        if (e.defaultPrevented) {
          return;
        }
        const activeId = get(activePanelId$);
        if (!activeId) {
          return;
        }

        if (matchShortcut("mod+shift+enter", e)) {
          e.preventDefault();
          set(toggleMaximizeTask$, activeId);
          return;
        }

        if (matchShortcut("escape", e)) {
          e.preventDefault();
          set(focusTaskCard$, activeId);
          return;
        }

        // ctrl+d — close active panel (panel-local handler covers the
        // textarea-empty case; this covers everywhere else)
        if (
          e.key === "d" &&
          e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey
        ) {
          e.preventDefault();
          await set(closeAndFocusNextInput$, activeId, signal);
        }
      }),
      { signal },
    );
  },
);

// ---------------------------------------------------------------------------
// Create and show chat task (optimistic flow)
// ---------------------------------------------------------------------------

/**
 * Full flow: create chat thread → insert optimistic task card → open panel → focus input.
 */
export const createAndShowChatTask$ = command(
  async (
    { get, set },
    agentId: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    // Step 1: Create (or reuse) chat thread
    const threadId = await set(createNewChatThread$, agentId, signal);
    signal.throwIfAborted();
    // If null, createNewChatThread$ already showed a toast (e.g. "No agent available")
    if (!threadId) {
      return;
    }

    // Step 2: Resolve agent info for the optimistic entry
    const allAgents = await get(agents$);
    signal.throwIfAborted();
    const resolvedAgentId =
      agentId ??
      (await get(zeroOnboardingStatus$)).defaultAgentId ??
      allAgents[0]?.id;
    if (!resolvedAgentId) {
      // No agent available — cannot create a meaningful optimistic entry
      return;
    }
    const agentInfo = allAgents.find((a) => {
      return a.id === resolvedAgentId;
    });

    // Step 3: Insert optimistic task signal (no-op if entry already exists)
    const ts = set(
      addOptimisticTask$,
      resolvedAgentId,
      threadId,
      agentInfo?.displayName ?? null,
      agentInfo?.avatarUrl ?? null,
    );

    // Step 4: Open the panel and focus input
    await set(ts.openTask$, signal);
    signal.throwIfAborted();
    set(ts.focusInput$);
  },
);

// ---------------------------------------------------------------------------
// Polling loop — reload tasks every 10s
// ---------------------------------------------------------------------------

export const setupMissionControlLoop$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(setupTasksLoop$, signal);
  },
);
