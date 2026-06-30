import { command, computed, state } from "ccstate";
import {
  zeroGoalsContract,
  type ZeroGoalResponse,
} from "@vm0/api-contracts/contracts/zero-goals";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

const activeGoalDialogThreadIdState$ = state<string | null>(null);

export const activeGoalDialogThreadId$ = computed((get): string | null => {
  return get(activeGoalDialogThreadIdState$);
});

export const activeGoalDialogGoal$ = computed(
  async (get): Promise<ZeroGoalResponse | null> => {
    const threadId = get(activeGoalDialogThreadIdState$);
    if (!threadId) {
      return null;
    }
    const client = get(zeroClient$)(zeroGoalsContract);
    const response = await accept(
      client.getForChatThread({ params: { threadId } }),
      [200],
      { toast: false },
    );
    return response.body;
  },
);

export const openChatThreadGoalDialog$ = command(
  ({ set }, threadId: string) => {
    set(activeGoalDialogThreadIdState$, threadId);
  },
);

export const closeChatThreadGoalDialog$ = command(({ set }) => {
  set(activeGoalDialogThreadIdState$, null);
});

export const pauseChatThreadGoal$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroGoalsContract);
    await accept(
      client.pauseForChatThread({
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
  },
);
