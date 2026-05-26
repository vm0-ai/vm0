import { command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import type { ChatThreadSignals } from "./create-chat-thread.ts";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import { onRef } from "../utils.ts";

/**
 * Snapshot row shape consumed by `navigateToAdjacentThread$`. The caller
 * passes the already-resolved sidebar list (via `useLastResolved`) so the
 * keyboard command stays synchronous on the read side — awaiting
 * `sidebarChatThreads$` here would block the keypress on whatever async
 * work that signal is currently doing (e.g. an IDB miss + remote refetch).
 */
interface NavigableThread {
  readonly id: string;
}

function plainArrowScrollDirection(
  event: KeyboardEvent,
): ScrollStepDirection | null {
  if (matchShortcut("arrowup", event)) {
    return "up";
  }
  if (matchShortcut("arrowdown", event)) {
    return "down";
  }
  return null;
}

function chatThreadIdForKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return null;
  }
  const threadContainer = target.closest<HTMLElement>(
    "[data-chat-thread-container-id]",
  );
  return threadContainer?.dataset.chatThreadContainerId ?? null;
}

function isKeyboardScrollBlockedTarget(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) {
    return true;
  }
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.closest('[role="dialog"]') !== null;
}

function isDocumentScrollTarget(root: HTMLElement, target: EventTarget | null) {
  const doc = root.ownerDocument;
  return (
    target === doc || target === doc.body || target === doc.documentElement
  );
}

function isKeyboardScrollAllowedTarget(
  root: HTMLElement,
  target: EventTarget | null,
): boolean {
  if (isKeyboardScrollBlockedTarget(target)) {
    return false;
  }
  return (
    isDocumentScrollTarget(root, target) ||
    (target instanceof Node && root.contains(target))
  );
}

function resolveKeyboardScrollThread(
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
  threadId: string | null,
): ChatThreadSignals | null {
  if (threadId === rightThread?.threadId) {
    return rightThread;
  }
  if (threadId === leftThread?.threadId) {
    return leftThread;
  }
  return leftThread;
}

export const setChatKeyboardScrollRoot$ = onRef(
  command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    let activeThreadId: string | null = null;

    const markActiveThread = (event: Event) => {
      activeThreadId = chatThreadIdForKeyboardTarget(event.target);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const direction = plainArrowScrollDirection(event);
      if (!direction || !isKeyboardScrollAllowedTarget(el, event.target)) {
        return;
      }
      const targetThreadId = chatThreadIdForKeyboardTarget(event.target);
      const thread = resolveKeyboardScrollThread(
        get(currentLeftThread$),
        get(currentRightThread$),
        targetThreadId ?? activeThreadId,
      );
      if (thread) {
        set(thread.prepareKeyboardScroll$);
      }
    };

    el.addEventListener("focusin", markActiveThread, { signal });
    el.addEventListener("pointerdown", markActiveThread, { signal });
    el.addEventListener("pointerover", markActiveThread, { signal });
    document.addEventListener("keydown", onKeyDown, { signal });
  }),
);

export const navigateToAdjacentThread$ = command(
  async (
    { get, set },
    args: {
      currentThreadId: string;
      direction: "prev" | "next";
      threads: readonly NavigableThread[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const leftThreadId = get(currentLeftThread$)?.threadId ?? null;
    const rightThreadId = get(currentRightThread$)?.threadId ?? null;
    const inMainPane = args.currentThreadId === leftThreadId;
    const inSidebarPane = args.currentThreadId === rightThreadId;
    if (!inMainPane && !inSidebarPane) {
      return;
    }

    const excludedThreadId = inMainPane ? rightThreadId : leftThreadId;
    const availableThreads = args.threads.filter((thread) => {
      return thread.id !== excludedThreadId;
    });
    const idx = availableThreads.findIndex((t) => {
      return t.id === args.currentThreadId;
    });
    if (idx === -1) {
      return;
    }
    const targetIdx = args.direction === "prev" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= availableThreads.length) {
      return;
    }
    const targetThreadId = availableThreads[targetIdx]!.id;
    if (inMainPane) {
      await set(loadLeftThread$, targetThreadId, signal);
    } else {
      await set(loadRightThread$, targetThreadId, signal);
    }
  },
);

export const scrollCurrentThread$ = command(
  (
    { set },
    thread: ChatThreadSignals,
    position: "top" | "bottom" | ScrollStepDirection,
  ): boolean => {
    if (position === "top") {
      set(thread.scrollToTop$);
      return true;
    }
    if (position === "bottom") {
      set(thread.scrollToBottom$);
      return true;
    }
    return set(thread.scrollBy$, position);
  },
);
