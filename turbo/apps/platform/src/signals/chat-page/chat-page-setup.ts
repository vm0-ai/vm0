import { command } from "ccstate";
import { createElement } from "react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ChatThreadPage } from "../../views/okou-page/chat-thread-page.tsx";
import { updatePage$ } from "../react-router.ts";
import { currentChatThreadId$ } from "../agent-chat.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { hash$, searchParams$ } from "../route.ts";
import {
  SIDEBAR_PARAM,
  setupLeftThread$,
  setupLeftThreadNotFound$,
  setupRightThread$,
  setupRightThreadNotFound$,
  unloadRightThread$,
} from "./chat-thread-panes.ts";
import { resolveThreadMeta$ } from "./chat-thread-event-sourcing.ts";
import {
  captureNavigationTiming$,
  markRouteSetupBegin$,
  recordBootstrapThreadMetadataTiming$,
} from "../../lib/posthog.ts";

const CHAT_EVENT_HASH_PREFIX = "#event-";

function chatEventIdFromHash(hash: string): string | null {
  if (!hash.startsWith(CHAT_EVENT_HASH_PREFIX)) {
    return null;
  }
  const encodedEventId = hash.slice(CHAT_EVENT_HASH_PREFIX.length);
  if (encodedEventId.length === 0) {
    return null;
  }
  return new URLSearchParams(
    `event=${encodedEventId.replaceAll("+", "%2B")}`,
  ).get("event");
}

const setupResolvedLeftThread$ = command(
  async (
    { set },
    threadId: string,
    initialEventId: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const resolution = await set(resolveThreadMeta$, threadId, signal);
    signal.throwIfAborted();
    set(recordBootstrapThreadMetadataTiming$, {
      localDurationMs: resolution.localDurationMs,
      remoteDurationMs: resolution.remoteDurationMs,
      source: resolution.source,
    });
    const { meta } = resolution;
    if (meta) {
      await set(setupLeftThread$, meta, initialEventId, signal);
      return;
    }
    await set(setupLeftThreadNotFound$, threadId, signal);
  },
);

const setupResolvedRightThread$ = command(
  async ({ set }, threadId: string, signal: AbortSignal): Promise<void> => {
    const { meta } = await set(resolveThreadMeta$, threadId, signal);
    signal.throwIfAborted();
    if (meta) {
      await set(setupRightThread$, meta, signal);
      return;
    }
    await set(setupRightThreadNotFound$, threadId, signal);
  },
);

const internalSetupChatPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(markRouteSetupBegin$);
    const threadId = get(currentChatThreadId$);
    if (!threadId) {
      throw new Error("threadId is required to load chat page");
    }

    set(updatePage$, createElement(ChatThreadPage), "sidebar");

    set(captureNavigationTiming$);

    const sidebarThreadId = get(searchParams$).get(SIDEBAR_PARAM);
    const initialEventId = get(featureSwitch$)[
      FeatureSwitchKey.ChatConversationLocator
    ]
      ? chatEventIdFromHash(get(hash$))
      : null;
    const rightThreadId =
      sidebarThreadId && sidebarThreadId !== threadId ? sidebarThreadId : null;

    await Promise.all([
      set(setupResolvedLeftThread$, threadId, initialEventId, signal),
      rightThreadId
        ? set(setupResolvedRightThread$, rightThreadId, signal)
        : set(unloadRightThread$),
    ]);
    signal.throwIfAborted();
  },
);

export const setupChatPage$ = command(async ({ set }, signal: AbortSignal) => {
  await set(internalSetupChatPage$, signal);
  signal.throwIfAborted();
});
