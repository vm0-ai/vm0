import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authRecovery$, clerk$ } from "./auth.ts";
import {
  subscribeChatThreadReadCursorUpdated$,
  subscribeThreadListChanged$,
  setupChatIndicatorForegroundCatchUp$,
} from "./chat-thread-list-reload.ts";
import { subscribeEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import {
  prewarmSharedUnreadChatEvents$,
  setupChatEventBackgroundSync$,
} from "./chat-page/chat-event-background-sync.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { setRealtimeDegradedNotifier$, setupRealtime$ } from "./realtime.ts";
import { i18n } from "../i18n/index.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribeCustomConnectorListChanged$ } from "./okou-page/settings/custom-connectors.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { selectSharedDatabaseMode$ } from "./shared-database-mode.ts";
import {
  heartbeatSharedDatabaseNow$,
  runSharedDatabaseHeartbeatLoop$,
  setupSharedDatabaseBridge$,
} from "./shared-database-browser.ts";
import { runSharedDatabaseInvalidationDaemon$ } from "./shared-database-invalidation-daemon.ts";

/** Start user-scoped background services after Clerk has resolved. */
export const setupAuthenticatedDaemons$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }
    set(setRealtimeDegradedNotifier$, () => {
      toast.error(
        i18n.t(($) => {
          return $.global.realtime.degraded;
        }),
      );
    });

    const sharedDatabaseEnabled =
      get(featureSwitch$)[FeatureSwitchKey.SharedChatDatabase] ?? false;
    set(selectSharedDatabaseMode$, sharedDatabaseEnabled);
    if (sharedDatabaseEnabled) {
      const authRecovery = await get(authRecovery$);
      signal.throwIfAborted();
      set(setupSharedDatabaseBridge$, authRecovery, signal);
      await set(heartbeatSharedDatabaseNow$, signal);
      signal.throwIfAborted();
    }

    await Promise.all([
      set(setupRealtime$, signal),
      set(subscribeThreadListChanged$, signal),
      set(subscribeChatThreadReadCursorUpdated$, signal),
      set(setupChatIndicatorForegroundCatchUp$, signal),
      set(subscribeEventDrivenChatThreads$, signal),
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(subscribePresentationTemplatesChanged$, signal),
      set(setupUserPreferenceRealtime$, signal),
      sharedDatabaseEnabled
        ? set(prewarmSharedUnreadChatEvents$, signal)
        : set(setupChatEventBackgroundSync$, signal),
      set(subscribeCustomConnectorListChanged$, signal),
      ...(sharedDatabaseEnabled
        ? [
            set(runSharedDatabaseHeartbeatLoop$, signal),
            set(runSharedDatabaseInvalidationDaemon$, signal),
          ]
        : []),
    ]);
  },
);
