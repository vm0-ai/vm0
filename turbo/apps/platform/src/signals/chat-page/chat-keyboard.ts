import { command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  clearChatThreadEmojiFromThreadData$,
  openRenameChatThreadDialogFromThreadData$,
  setChatThreadEmojiFromThreadData$,
} from "./chat-thread-rename.ts";
import { CHAT_THREAD_EMOJI_OPTIONS } from "./chat-thread-title.ts";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import { onRef } from "../utils.ts";
import { openChatThreadEmojiMenu$ } from "../zero-page/zero-sidebar-state.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  setupGlobalShortcut,
  type GlobalShortcutBindings,
} from "../../lib/setup-global-shortcut.ts";
import { sidebarChatThreads$ } from "./optimistic-chat-thread-page.ts";

interface NavigableThread {
  readonly id: string;
  readonly title?: string | null;
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

function containerContainsTarget(
  container: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  return target instanceof Node && container?.contains(target) === true;
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

const focusedThreadSidebarTitle$ = command(
  async ({ get }, thread: ChatThreadSignals, signal: AbortSignal) => {
    const threads = await get(sidebarChatThreads$);
    signal.throwIfAborted();
    const navigableThread = threads.find((item) => {
      return item.id === thread.threadId;
    });
    return navigableThread?.title;
  },
);

const setFocusedThreadEmoji$ = command(
  async (
    { get, set },
    args: { thread: ChatThreadSignals; emoji: string },
    signal: AbortSignal,
  ) => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatThreadEmoji] ?? false)) {
      return;
    }
    await set(
      setChatThreadEmojiFromThreadData$,
      {
        threadId: args.thread.threadId,
        emoji: args.emoji,
        title: await set(focusedThreadSidebarTitle$, args.thread, signal),
      },
      signal,
    );
  },
);

const clearFocusedThreadEmoji$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatThreadEmoji] ?? false)) {
      return;
    }
    await set(
      clearChatThreadEmojiFromThreadData$,
      {
        threadId: thread.threadId,
        title: await set(focusedThreadSidebarTitle$, thread, signal),
      },
      signal,
    );
  },
);

const openFocusedThreadEmojiMenu$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatThreadEmoji] ?? false)) {
      return;
    }
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    const snapshotTitle = await set(focusedThreadSidebarTitle$, thread, signal);
    signal.throwIfAborted();
    const title =
      snapshotTitle !== undefined ? snapshotTitle : threadData?.title;
    set(openChatThreadEmojiMenu$, { threadId: thread.threadId, title });
  },
);

const navigateFocusedThreadFromSidebar$ = command(
  async (
    { get, set },
    args: {
      thread: ChatThreadSignals | null;
      direction: "prev" | "next";
    },
    signal: AbortSignal,
  ) => {
    if (!args.thread) {
      return;
    }
    const threads = await get(sidebarChatThreads$);
    signal.throwIfAborted();
    await set(
      navigateToAdjacentThread$,
      {
        currentThreadId: args.thread.threadId,
        direction: args.direction,
        threads,
      },
      signal,
    );
  },
);

function createEmojiShortcutBindings({
  clearEmoji,
  setEmoji,
}: {
  clearEmoji: () => void | Promise<void>;
  setEmoji: (emoji: string) => void | Promise<void>;
}): GlobalShortcutBindings {
  return {
    ...(Object.fromEntries(
      CHAT_THREAD_EMOJI_OPTIONS.map((option, index) => {
        return [
          `shift+${index + 1}`,
          {
            run: async () => {
              await setEmoji(option.emoji);
            },
          },
        ];
      }),
    ) as GlobalShortcutBindings),
    "shift+0": {
      run: clearEmoji,
    },
  };
}

function createChatPageShortcutBindings({
  clearEmoji,
  openEmojiMenu,
  renameThread,
  navigateNext,
  navigatePrev,
  scrollBottom,
  scrollTop,
  setEmoji,
}: {
  clearEmoji: () => void | Promise<void>;
  openEmojiMenu: () => void | Promise<void>;
  renameThread: () => void | Promise<void>;
  navigateNext: () => void | Promise<void>;
  navigatePrev: () => void | Promise<void>;
  scrollBottom: () => void | Promise<void>;
  scrollTop: () => void | Promise<void>;
  setEmoji: (emoji: string) => void | Promise<void>;
}): GlobalShortcutBindings {
  return {
    "shift+f2": {
      allowInEditableTarget: true,
      run: openEmojiMenu,
    },
    f2: {
      allowInEditableTarget: true,
      run: renameThread,
    },
    "mod+shift+arrowup": {
      allowInEditableTarget: true,
      run: navigatePrev,
    },
    "mod+shift+arrowdown": {
      allowInEditableTarget: true,
      run: navigateNext,
    },
    "mod+arrowup": {
      allowInEditableTarget: true,
      run: scrollTop,
    },
    "mod+arrowdown": {
      allowInEditableTarget: true,
      run: scrollBottom,
    },
    ...createEmojiShortcutBindings({ clearEmoji, setEmoji }),
  };
}

export const focusChatThreadContainer$ = command(
  ({ get }, threadId: string) => {
    const leftThread = get(currentLeftThread$);
    const rightThread = get(currentRightThread$);
    const thread =
      threadId === rightThread?.threadId
        ? rightThread
        : threadId === leftThread?.threadId
          ? leftThread
          : null;
    if (!thread) {
      return false;
    }
    const containerEl = get(thread.containerEl$);
    if (!containerEl) {
      return false;
    }
    containerEl.focus({ preventScroll: true });
    return true;
  },
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

export const setChatKeyboardScrollRoot$ = onRef(
  command(({ get, set }, el: HTMLElement, signal: AbortSignal) => {
    let activeThreadId: string | null = null;
    const doc = el.ownerDocument;

    const containingThread = (target: EventTarget | null) => {
      const leftThread = get(currentLeftThread$);
      const rightThread = get(currentRightThread$);
      if (
        rightThread &&
        containerContainsTarget(get(rightThread.containerEl$), target)
      ) {
        return rightThread;
      }
      if (
        leftThread &&
        containerContainsTarget(get(leftThread.containerEl$), target)
      ) {
        return leftThread;
      }
      return null;
    };
    const markActiveThread = (event: Event) => {
      activeThreadId = containingThread(event.target)?.threadId ?? null;
    };
    const focusedThread = () => {
      return containingThread(doc.activeElement) ?? get(currentLeftThread$);
    };

    el.addEventListener("focusin", markActiveThread, { signal });
    el.addEventListener("pointerdown", markActiveThread, { signal });
    el.addEventListener("pointerover", markActiveThread, { signal });
    setupGlobalShortcut(
      createChatPageShortcutBindings({
        clearEmoji: async () => {
          const thread = focusedThread();
          if (thread) {
            await set(clearFocusedThreadEmoji$, thread, signal);
          }
        },
        openEmojiMenu: async () => {
          const thread = focusedThread();
          if (thread) {
            await set(openFocusedThreadEmojiMenu$, thread, signal);
          }
        },
        renameThread: async () => {
          const thread = focusedThread();
          if (thread) {
            await set(
              openRenameChatThreadDialogFromThreadData$,
              thread.threadId,
              signal,
            );
          }
        },
        navigateNext: async () => {
          await set(
            navigateFocusedThreadFromSidebar$,
            { thread: focusedThread(), direction: "next" },
            signal,
          );
        },
        navigatePrev: async () => {
          await set(
            navigateFocusedThreadFromSidebar$,
            { thread: focusedThread(), direction: "prev" },
            signal,
          );
        },
        scrollBottom: () => {
          const thread = focusedThread();
          if (thread) {
            set(scrollCurrentThread$, thread, "bottom");
          }
        },
        scrollTop: () => {
          const thread = focusedThread();
          if (thread) {
            set(scrollCurrentThread$, thread, "top");
          }
        },
        setEmoji: async (emoji) => {
          const thread = focusedThread();
          if (thread) {
            await set(setFocusedThreadEmoji$, { thread, emoji }, signal);
          }
        },
      }),
      signal,
      {
        doc,
        shouldHandleEvent: (event) => {
          return isChatShortcutTarget(el, event.target);
        },
      },
    );
    doc.addEventListener(
      "keydown",
      (event) => {
        if (event.defaultPrevented) {
          return;
        }
        const direction = plainArrowScrollDirection(event);
        if (!direction || !isKeyboardScrollAllowedTarget(el, event.target)) {
          return;
        }
        const thread = resolveKeyboardScrollThread(
          get(currentLeftThread$),
          get(currentRightThread$),
          containingThread(event.target)?.threadId ?? activeThreadId,
        );
        if (thread) {
          set(thread.prepareKeyboardScroll$);
        }
      },
      { signal },
    );
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
