import { command } from "ccstate";
import { animationFrame } from "signal-timers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../external/feature-switch.ts";
import type { ChatThreadSignals } from "./create-chat-thread.ts";

export const setupChatThreadInitScroll$ = command(
  async ({ get, set }, thread: ChatThreadSignals, signal: AbortSignal) => {
    await get(thread.groupedChatMessages$);
    signal.throwIfAborted();

    animationFrame(
      () => {
        set(thread.scrollToBottom$);
        set(thread.hideSkeleton$);
      },
      { signal },
    );

    // When the thread has a queued (pending) message attached, the queued-
    // message card renders below the message list and grows the scrollable
    // content after `groupedChatMessages$` resolves. Re-scroll on the next
    // frame so the user lands at the bottom — same shape as the grouped-
    // message scroll above, but gated on `pendingMessage` being present.
    // Skip the extra threadData$ read entirely when the queue feature is
    // off so users without the feature follow the original code path.
    const queueEnabled =
      get(featureSwitch$)[FeatureSwitchKey.QueueMessage] ?? false;
    if (!queueEnabled) {
      return;
    }
    const threadData = await get(thread.threadData$);
    signal.throwIfAborted();
    if (threadData?.pendingMessage) {
      animationFrame(
        () => {
          set(thread.scrollToBottom$);
        },
        { signal },
      );
    }
  },
);
