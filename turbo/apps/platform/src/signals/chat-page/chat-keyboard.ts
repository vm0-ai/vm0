import { command } from "ccstate";
import { isEditableTarget, matchShortcut } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  currentLeftThread$,
  currentRightThread$,
  loadLeftThread$,
  loadRightThread$,
} from "./chat-thread-panes.ts";
import {
  clickAdjacentSidebarThread,
  sidebarThreadTitleForPane,
  type SidebarThreadPane,
} from "./chat-sidebar-dom.ts";
import type { ChatThreadSignals } from "./chat-thread-signals.ts";
import {
  clearChatThreadEmojiFromThreadData$,
  openRenameChatThreadDialogFromThreadData$,
  setChatThreadEmojiFromThreadData$,
  type RenameChatThreadDialogRequest,
} from "./chat-thread-rename.ts";
import { eventDrivenChatThreadMeta } from "./chat-thread-event-sourcing.ts";
import { CHAT_THREAD_EMOJI_OPTIONS } from "./chat-thread-title.ts";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import { onRef } from "../utils.ts";
import { openChatThreadEmojiMenu$ } from "../zero-page/zero-sidebar-state.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { sidebarChatThreadIds$ } from "./sidebar-chat-thread-ids.ts";
import {
  setupGlobalShortcut,
  type GlobalShortcutBindings,
} from "../../lib/setup-global-shortcut.ts";
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

function containingChatThread(
  target: EventTarget | null,
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
  containerElForThread: (thread: ChatThreadSignals) => HTMLElement | null,
): ChatThreadSignals | null {
  if (
    rightThread &&
    containerContainsTarget(containerElForThread(rightThread), target)
  ) {
    return rightThread;
  }
  if (
    leftThread &&
    containerContainsTarget(containerElForThread(leftThread), target)
  ) {
    return leftThread;
  }
  return null;
}

function paneForThread(
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
  thread: ChatThreadSignals | null,
): SidebarThreadPane | null {
  if (!thread) {
    return null;
  }
  if (thread.threadId === rightThread?.threadId) {
    return "side";
  }
  if (thread.threadId === leftThread?.threadId) {
    return "main";
  }
  return null;
}

function setupKeyboardScrollPrepareListener({
  activeThreadId,
  containingThread,
  currentLeftThread,
  currentRightThread,
  doc,
  prepareScroll,
  root,
  signal,
}: {
  activeThreadId: () => string | null;
  containingThread: (target: EventTarget | null) => ChatThreadSignals | null;
  currentLeftThread: () => ChatThreadSignals | null;
  currentRightThread: () => ChatThreadSignals | null;
  doc: Document;
  prepareScroll: (thread: ChatThreadSignals) => void;
  root: HTMLElement;
  signal: AbortSignal;
}): void {
  doc.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) {
        return;
      }
      const direction = plainArrowScrollDirection(event);
      if (!direction || !isKeyboardScrollAllowedTarget(root, event.target)) {
        return;
      }
      const thread = resolveKeyboardScrollThread(
        currentLeftThread(),
        currentRightThread(),
        containingThread(event.target)?.threadId ?? activeThreadId(),
      );
      if (thread) {
        prepareScroll(thread);
      }
    },
    { signal },
  );
}

interface ChatPageShortcutActions {
  clearEmoji: () => void | Promise<void>;
  openEmojiMenu: () => void | Promise<void>;
  renameThread: () => void | Promise<void>;
  navigateNext: () => void | Promise<void>;
  navigatePrev: () => void | Promise<void>;
  scrollBottom: () => void | Promise<void>;
  scrollTop: () => void | Promise<void>;
  setEmoji: (emoji: string) => void | Promise<void>;
}

interface ChatPageShortcutSetup {
  doc: Document;
  focusedThread: () => ChatThreadSignals | null;
  navigateFocusedThread: (direction: "prev" | "next") => void | Promise<void>;
  root: HTMLElement;
  sidebarTitleForThread: (
    thread: ChatThreadSignals,
  ) => string | null | undefined;
}

function setupChatPageGlobalShortcutListener({
  actions,
  doc,
  root,
  signal,
}: {
  actions: ChatPageShortcutActions;
  doc: Document;
  root: HTMLElement;
  signal: AbortSignal;
}): void {
  setupGlobalShortcut(createChatPageShortcutBindings(actions), signal, {
    doc,
    shouldHandleEvent: (event) => {
      return isChatShortcutTarget(root, event.target);
    },
  });
}

const setFocusedThreadEmoji$ = command(
  async (
    { get, set },
    args: {
      thread: ChatThreadSignals;
      emoji: string;
      title?: string | null;
    },
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
        title: args.title,
      },
      signal,
    );
  },
);

const setupChatPageShortcutActions$ = command(
  (
    { get, set },
    {
      doc,
      focusedThread,
      navigateFocusedThread,
      root,
      sidebarTitleForThread,
    }: ChatPageShortcutSetup,
    signal: AbortSignal,
  ) => {
    setupChatPageGlobalShortcutListener({
      actions: {
        clearEmoji: async () => {
          const thread = focusedThread();
          if (thread) {
            await set(
              clearFocusedThreadEmoji$,
              { thread, title: sidebarTitleForThread(thread) },
              signal,
            );
          }
        },
        openEmojiMenu: async () => {
          const thread = focusedThread();
          if (thread) {
            await set(
              openFocusedThreadEmojiMenu$,
              { thread, title: sidebarTitleForThread(thread) },
              signal,
            );
          }
        },
        renameThread: async () => {
          const thread = focusedThread();
          const threadId = thread?.threadId ?? get(currentChatThreadId$);
          if (threadId) {
            const request = await set(
              renameDialogRequestForThread$,
              thread,
              threadId,
              signal,
            );
            await set(
              openRenameChatThreadDialogFromThreadData$,
              request,
              signal,
            );
          }
        },
        navigateNext: () => {
          return navigateFocusedThread("next");
        },
        navigatePrev: () => {
          return navigateFocusedThread("prev");
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
            await set(
              setFocusedThreadEmoji$,
              { thread, emoji, title: sidebarTitleForThread(thread) },
              signal,
            );
          }
        },
      },
      doc,
      root,
      signal,
    });
  },
);

const clearFocusedThreadEmoji$ = command(
  async (
    { get, set },
    args: { thread: ChatThreadSignals; title?: string | null },
    signal: AbortSignal,
  ) => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatThreadEmoji] ?? false)) {
      return;
    }
    await set(
      clearChatThreadEmojiFromThreadData$,
      {
        threadId: args.thread.threadId,
        title: args.title,
      },
      signal,
    );
  },
);

const openFocusedThreadEmojiMenu$ = command(
  async (
    { get, set },
    args: { thread: ChatThreadSignals; title?: string | null },
    signal: AbortSignal,
  ) => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatThreadEmoji] ?? false)) {
      return;
    }
    const threadMeta = await get(args.thread.threadMeta$);
    signal.throwIfAborted();
    const title = args.title !== undefined ? args.title : threadMeta?.title;
    set(openChatThreadEmojiMenu$, { threadId: args.thread.threadId, title });
  },
);

const renameDialogRequestForThread$ = command(
  async (
    { get },
    thread: ChatThreadSignals | null,
    threadId: string,
    signal: AbortSignal,
  ): Promise<RenameChatThreadDialogRequest> => {
    const threadMeta = thread
      ? await get(thread.threadMeta$)
      : await get(eventDrivenChatThreadMeta(threadId));
    signal.throwIfAborted();
    return {
      threadId,
      title: threadMeta?.title,
      agentId: threadMeta?.agentId,
    };
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
          `ctrl+shift+${index + 1}`,
          {
            allowInEditableTarget: true,
            run: async () => {
              await setEmoji(option.emoji);
            },
          },
        ];
      }),
    ) as GlobalShortcutBindings),
    "ctrl+shift+0": {
      allowInEditableTarget: true,
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
}: ChatPageShortcutActions): GlobalShortcutBindings {
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
      return containingChatThread(
        target,
        get(currentLeftThread$),
        get(currentRightThread$),
        (thread) => {
          return get(thread.containerEl$);
        },
      );
    };
    const markActiveThread = (event: Event) => {
      activeThreadId = containingThread(event.target)?.threadId ?? null;
    };
    const focusedThread = () => {
      return containingThread(doc.activeElement) ?? get(currentLeftThread$);
    };
    const sidebarTitleForThread = (thread: ChatThreadSignals) => {
      return sidebarThreadTitleForPane(
        el,
        paneForThread(
          get(currentLeftThread$),
          get(currentRightThread$),
          thread,
        ),
        thread.threadId,
      );
    };
    const navigateFocusedThread = (direction: "prev" | "next") => {
      const pane = paneForThread(
        get(currentLeftThread$),
        get(currentRightThread$),
        focusedThread(),
      );
      if (!pane) {
        return;
      }
      if (
        get(featureSwitch$)[FeatureSwitchKey.ChatThreadSidebarVirtualList] ??
        false
      ) {
        return navigateAdjacentSidebarThreadFromSignals(pane, direction);
      }
      clickAdjacentSidebarThread(el, pane, direction);
      return;
    };

    const navigateAdjacentSidebarThreadFromSignals = async (
      pane: SidebarThreadPane,
      direction: "prev" | "next",
    ) => {
      const leftThread = get(currentLeftThread$);
      const rightThread = get(currentRightThread$);
      const currentId =
        pane === "main" ? leftThread?.threadId : rightThread?.threadId;
      if (!currentId) {
        return;
      }
      const otherPaneThreadId =
        pane === "main" ? rightThread?.threadId : leftThread?.threadId;
      const ids = (await get(sidebarChatThreadIds$)).filter((id) => {
        return id !== otherPaneThreadId;
      });
      const currentIndex = ids.indexOf(currentId);
      if (currentIndex === -1) {
        return;
      }
      const targetIndex =
        direction === "prev" ? currentIndex - 1 : currentIndex + 1;
      const targetId = ids[targetIndex];
      if (!targetId) {
        return;
      }
      const promise =
        pane === "main"
          ? set(loadLeftThread$, targetId, signal)
          : set(loadRightThread$, targetId, signal);
      await promise;
    };

    el.addEventListener("focusin", markActiveThread, { signal });
    el.addEventListener("pointerdown", markActiveThread, { signal });
    el.addEventListener("pointerover", markActiveThread, { signal });
    set(
      setupChatPageShortcutActions$,
      {
        doc,
        focusedThread,
        navigateFocusedThread,
        root: el,
        sidebarTitleForThread,
      },
      signal,
    );
    setupKeyboardScrollPrepareListener({
      containingThread,
      doc,
      root: el,
      signal,
      activeThreadId() {
        return activeThreadId;
      },
      currentLeftThread() {
        return get(currentLeftThread$);
      },
      currentRightThread() {
        return get(currentRightThread$);
      },
      prepareScroll(thread) {
        set(thread.prepareKeyboardScroll$);
      },
    });
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
