import { command } from "ccstate";
import { toast } from "@okouai/ui/components/ui/sonner";
import { clerk$, setupClerk$ } from "./auth.ts";
import { setAuthenticatedIdentity$ } from "./auth-context.ts";
import { setupChatIndicatorForegroundCatchUp$ } from "./chat-thread-list-reload.ts";
import { subscribeEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { setupUserPreferenceRealtime$ } from "./external/user-model-preference.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { setRealtimeDegradedNotifier$, setupRealtime$ } from "./realtime.ts";
import { i18n } from "../i18n/index.ts";
import { setupBillingRealtime$ } from "./okou-page/billing.ts";
import { subscribePresentationTemplatesChanged$ } from "./okou-page/presentation-template-library.ts";
import { subscribeCustomConnectorListChanged$ } from "./okou-page/settings/custom-connectors.ts";
import { bridgeConnected$ } from "./shared-database-bridge-state.ts";

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

/** Run user-scoped application realtime services for the root lifecycle. */
export const runAuthenticatedRealtime$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
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

    await set(runAppRealtimeDaemons$, signal);
  },
);

/** Complete finite authenticated data setup while the initial route loads. */
export const setupAuthenticatedBootstrapData$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }
    await get(bridgeConnected$);
    signal.throwIfAborted();
    await Promise.all([
      set(setupChatIndicatorForegroundCatchUp$, signal),
      set(subscribeEventDrivenChatThreads$, signal),
    ]);
  },
);
