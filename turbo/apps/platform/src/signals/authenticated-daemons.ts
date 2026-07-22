import { command } from "ccstate";
import { clerk$ } from "./auth.ts";
import {
  subscribeChatThreadReadCursorUpdated$,
  subscribeThreadListChanged$,
} from "./chat-thread-list-reload.ts";
import { subscribeEventDrivenChatThreads$ } from "./chat-page/chat-thread-event-sourcing.ts";
import { subscribeConnectorChanged$ } from "./connector-reload.ts";
import { reloadFeatureSwitch$ } from "./external/feature-switch.ts";
import { subscribePermissionUpdate$ } from "./permission-allow/permission-allow-signals.ts";
import { setupRealtime$ } from "./realtime.ts";
import { setupBillingRealtime$ } from "./zero-page/billing.ts";

/** Start user-scoped background services after Clerk has resolved. */
export const setupAuthenticatedDaemons$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }

    await Promise.all([
      set(setupRealtime$, signal),
      set(subscribeThreadListChanged$, signal),
      set(subscribeChatThreadReadCursorUpdated$, signal),
      set(subscribeEventDrivenChatThreads$, signal),
      set(subscribeConnectorChanged$, signal),
      set(subscribePermissionUpdate$, signal),
      set(setupBillingRealtime$, signal),
      set(reloadFeatureSwitch$, signal),
    ]);
  },
);
