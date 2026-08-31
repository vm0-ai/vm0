import { command, state } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { authRecovery$, clerk$, setupClerk$ } from "./auth.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import { setupChatIndicatorForegroundCatchUp$ } from "./chat-thread-list-reload.ts";
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

const authenticatedServicesInstalled$ = state(false);

export type AuthenticatedDaemonOwner = (daemon: Promise<void>) => void;

const runAppRealtimeDaemons$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(setupRealtime$, signal);
    signal.throwIfAborted();
    await Promise.all([
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(subscribePresentationTemplatesChanged$, signal),
      set(setupUserPreferenceRealtime$, signal),
      set(subscribeCustomConnectorListChanged$, signal),
    ]);
  },
);

/** Install user-scoped application services during bootstrap. */
export const setupAuthenticatedDaemons$ = command(
  async (
    { get, set },
    ownDaemon: AuthenticatedDaemonOwner,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(setupClerk$, signal);
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
    const appRealtimeDaemons = set(runAppRealtimeDaemons$, signal);
    ownDaemon(appRealtimeDaemons);
    await set(setupSharedDatabaseBridge$, authRecovery, signal);
    signal.throwIfAborted();
    set(authenticatedServicesInstalled$, true);
  },
);

/** Complete finite authenticated data setup while the initial route loads. */
export const setupAuthenticatedBootstrapData$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (!get(authenticatedServicesInstalled$)) {
      return;
    }
    await Promise.all([
      set(setupChatIndicatorForegroundCatchUp$, signal),
      set(subscribeEventDrivenChatThreads$, signal),
      set(prewarmSharedUnreadChatEvents$, signal),
    ]);
  },
);

/** Run SharedWorker-backed authenticated root-lifecycle loops. */
export const runAuthenticatedDaemons$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (!get(authenticatedServicesInstalled$)) {
      return;
    }
    await Promise.all([
      set(runSharedDatabaseHeartbeatLoop$, signal),
      set(runSharedDatabaseInvalidationDaemon$, signal),
    ]);
  },
);
