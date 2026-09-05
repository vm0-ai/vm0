import { command } from "ccstate";
import {
  setupGlobalShortcut,
  type GlobalShortcutBinding,
} from "../../lib/setup-global-shortcut.ts";
import { currentChatThreadListIds$ } from "../agent-chat.ts";
import { selectSidebarChatThread$ } from "../chat-page/sidebar-chat-thread-item.ts";
import { chatThreadNumberShortcutsEnabled$ } from "../external/feature-switch.ts";
import { navigateToChat$ } from "./nav.ts";

const navigateToNumberedChatThread$ = command(
  async ({ get, set }, index: number, signal: AbortSignal) => {
    const threadIds = await get(currentChatThreadListIds$);
    signal.throwIfAborted();
    const threadId = threadIds[index];
    if (!threadId) {
      return;
    }
    if (!set(selectSidebarChatThread$, threadId, "main")) {
      set(navigateToChat$, threadId);
    }
  },
);

export const setupChatThreadNumberShortcuts$ = command(
  ({ get, set }, signal: AbortSignal) => {
    setupGlobalShortcut(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => {
          return [
            `ctrl+shift+${index + 1}`,
            {
              allowInEditableTarget: true,
              shouldHandle: (event) => {
                return (
                  get(chatThreadNumberShortcutsEnabled$) &&
                  !event.repeat &&
                  !event.isComposing &&
                  event.keyCode !== 229
                );
              },
              run: async () => {
                await set(navigateToNumberedChatThread$, index, signal);
              },
            } satisfies GlobalShortcutBinding,
          ] as const;
        }),
      ),
      signal,
    );
  },
);
