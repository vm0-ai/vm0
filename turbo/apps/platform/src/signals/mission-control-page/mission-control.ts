import { command, computed, state } from "ccstate";
import { toggleTaskList$ } from "./mission-control-panels.ts";
import { archiveTask$, setupTasksLoop$ } from "./mission-control-tasks.ts";
import { setupGlobalShortcut } from "../../lib/setup-global-shortcut.ts";
import { onRef, throwIfNotAbort } from "../utils.ts";

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
            void set(archiveTask$, taskId, signal).catch(throwIfNotAbort);
          }
        },
      },
      signal,
    );
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
