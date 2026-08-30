import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { authRecovery$, clerk$ } from "./auth.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import {
  subscribeChatThreadReadCursorUpdated$,
  setupChatIndicatorForegroundCatchUp$,
} from "./chat-thread-list-reload.ts";
import { subscribeEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { prewarmSharedUnreadChatEvents$ } from "./chat-page/chat-event-background-sync.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { setRealtimeDegradedNotifier$, setupRealtime$ } from "./realtime.ts";
import { i18n } from "../i18n/index.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribeCustomConnectorListChanged$ } from "./okou-page/settings/custom-connectors.ts";
import {
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
    set(
      setAuthenticatedIdentity$,
      Promise.resolve({
        userId: clerk.user.id,
        orgId: clerk.organization.id,
        email: clerk.user.primaryEmailAddress?.emailAddress,
      }),
    );
    set(setRealtimeDegradedNotifier$, () => {
      toast.error(
        i18n.t(($) => {
          return $.global.realtime.degraded;
        }),
      );
    });

    const authRecovery = await get(authRecovery$);
    signal.throwIfAborted();
    await set(setupSharedDatabaseBridge$, authRecovery, signal);
    signal.throwIfAborted();

    await Promise.all([
      set(setupRealtime$, signal),
      set(subscribeChatThreadReadCursorUpdated$, signal),
      set(setupChatIndicatorForegroundCatchUp$, signal),
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(subscribePresentationTemplatesChanged$, signal),
      set(setupUserPreferenceRealtime$, signal),
      set(subscribeCustomConnectorListChanged$, signal),
      set(subscribeEventDrivenChatThreads$, signal),
      set(prewarmSharedUnreadChatEvents$, signal),
      set(runSharedDatabaseHeartbeatLoop$, signal),
      set(runSharedDatabaseInvalidationDaemon$, signal),
    ]);
  },
);
