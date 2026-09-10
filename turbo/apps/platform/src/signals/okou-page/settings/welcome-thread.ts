import { command, computed, state, type Command } from "ccstate";
import { welcomeChatThreadsContract } from "@okouai/api-contracts/contracts/welcome-chat-threads";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { clerk$ } from "../../auth.ts";
import { syncEventDrivenChatThreads$ } from "../../chat-page/chat-thread-event-sourcing.ts";
import { rootSignal$ } from "../../root-signal.ts";
import { createChildAbortController, withCleanup } from "../../utils.ts";
import { navigateToChat$ } from "../nav.ts";
import {
  closeSettingsModal$,
  settingsActionSignal$,
} from "./settings-dialog.ts";

export interface WelcomeThreadAction {
  readonly create$: Command<Promise<void>, [AbortSignal]>;
}

export const welcomeThreadAction$ = computed(
  async (get): Promise<WelcomeThreadAction> => {
    const dialogSignal = get(settingsActionSignal$);
    const clerk = await get(clerk$);
    const userId = clerk.user?.id;
    const orgId = clerk.organization?.id;
    const clientThreadId$ = state<string | null>(null);
    const inFlight$ = state<Promise<void> | null>(null);
    const create$ = command(async ({ get, set }, pageSignal: AbortSignal) => {
      if (
        !dialogSignal ||
        dialogSignal.aborted ||
        clerk.user?.id !== userId ||
        clerk.organization?.id !== orgId
      ) {
        return;
      }
      const inFlight = get(inFlight$);
      if (inFlight) {
        return await inFlight;
      }
      // A committed welcome's shared list recovery outlives its UI wait, but
      // remains owned by this app and the captured user/workspace identity.
      const controller = createChildAbortController(get(rootSignal$));
      const signal = AbortSignal.any([
        dialogSignal,
        pageSignal,
        controller.signal,
      ]);
      const unsubscribe = clerk.addListener(() => {
        // Like watchOrgSwitch$, retain the concrete workspace during a
        // transient Clerk token refresh; a different workspace cancels us.
        const currentOrgId = clerk.organization?.id;
        if (
          clerk.user?.id !== userId ||
          (currentOrgId && currentOrgId !== orgId)
        ) {
          controller.abort();
        }
      });
      controller.signal.addEventListener("abort", unsubscribe, { once: true });
      // Retain the action identity after every failure, including a lost 201.
      const clientThreadId = get(clientThreadId$) ?? crypto.randomUUID();
      set(clientThreadId$, clientThreadId);
      const result = withCleanup(
        (async () => {
          signal.throwIfAborted();
          const result = await accept(
            get(apiClient$)(welcomeChatThreadsContract).create({
              body: { clientThreadId },
              fetchOptions: { signal },
            }),
            [201],
            signal,
          );
          // Recover the ordinary list even when the creation notification was lost.
          await set(syncEventDrivenChatThreads$, controller.signal);
          signal.throwIfAborted();
          set(closeSettingsModal$);
          set(navigateToChat$, result.body.id);
        })(),
        () => {
          if (!signal.aborted) {
            set(inFlight$, null);
          }
          controller.abort();
        },
      );
      set(inFlight$, result);
      return await result;
    });
    return { create$ };
  },
);
