import { command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import { sidebarChatThreads$ } from "./optimistic-chat-thread-page.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import { onDomEventFn, onRef } from "../utils.ts";
import {
  openChatThreadEmojiDialog$,
  openRenameChatThreadDialog$,
} from "../zero-page/zero-sidebar-state.ts";

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

function isChatShortcutTarget(root: HTMLElement, target: EventTarget | null) {
  return (
    isDocumentScrollTarget(root, target) ||
    (target instanceof Node && root.contains(target))
  );
}

function hasOpenDialog(doc: Document): boolean {
  return doc.querySelector('[role="dialog"]') !== null;
}

function resolveChatThreadShortcutTitle(
  threadId: string,
  threadDataTitle: string | null | undefined,
  sidebarThreads: readonly { id: string; title: string | null }[],
): string | null | undefined {
  if (threadDataTitle?.trim()) {
    return threadDataTitle;
  }
  return (
    sidebarThreads.find((thread) => {
      return thread.id === threadId;
    })?.title ?? threadDataTitle
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

    const onGlobalChatKeyDown = onDomEventFn(async (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (!matchShortcut("f2", event) && !matchShortcut("shift+f2", event)) ||
        hasOpenDialog(el.ownerDocument) ||
        !isChatShortcutTarget(el, event.target)
      ) {
        return;
      }
      const mainThread = get(currentLeftThread$);
      if (!mainThread) {
        return;
      }

      event.preventDefault();
      const threadData = await get(mainThread.threadData$);
      const sidebarThreads = await get(sidebarChatThreads$);
      signal.throwIfAborted();
      const dialogPayload = {
        threadId: mainThread.threadId,
        title: resolveChatThreadShortcutTitle(
          mainThread.threadId,
          threadData?.title,
          sidebarThreads,
        ),
      };
      if (matchShortcut("shift+f2", event)) {
        set(openChatThreadEmojiDialog$, dialogPayload);
      } else {
        set(openRenameChatThreadDialog$, dialogPayload);
      }
    });

    el.addEventListener("focusin", markActiveThread, { signal });
    el.addEventListener("pointerdown", markActiveThread, { signal });
    el.addEventListener("pointerover", markActiveThread, { signal });
    document.addEventListener("keydown", onGlobalChatKeyDown, {
      capture: true,
      signal,
    });
    document.addEventListener("keydown", onKeyDown, { signal });
  }),
);

export const setMainChatThreadKeyboardFocusRef$ = onRef(
  command((_, el: HTMLElement, signal: AbortSignal) => {
    const doc = el.ownerDocument;
    const win = doc.defaultView;

    const focusMainThreadIfDocumentFocused = (
      target: EventTarget | null = doc.activeElement,
    ) => {
      if (
        !el.isConnected ||
        hasOpenDialog(doc) ||
        !isDocumentScrollTarget(el, target)
      ) {
        return;
      }
      el.focus({ preventScroll: true });
    };

    queueMicrotask(() => {
      if (!signal.aborted) {
        focusMainThreadIfDocumentFocused();
      }
    });

    doc.addEventListener(
      "focusin",
      (event) => {
        focusMainThreadIfDocumentFocused(event.target);
      },
      { signal },
    );
    win?.addEventListener(
      "focus",
      () => {
        focusMainThreadIfDocumentFocused();
      },
      { signal },
    );
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
