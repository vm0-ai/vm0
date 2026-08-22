import { command, computed, state } from "ccstate";
import {
  goalsContract,
  type GoalResponse,
} from "@okouai/api-contracts/contracts/goals";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";

const activeGoalDialogThreadIdState$ = state<string | null>(null);

export const activeGoalDialogThreadId$ = computed((get): string | null => {
  return get(activeGoalDialogThreadIdState$);
});

export const activeGoalDialogGoal$ = computed(
  async (get): Promise<GoalResponse | null> => {
    const threadId = get(activeGoalDialogThreadIdState$);
    if (!threadId) {
      return null;
    }
    const client = get(apiClient$)(goalsContract);
    const response = await accept(
      client.getForChatThread({ params: { threadId } }),
      [200],
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
    const client = get(apiClient$)(goalsContract);
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
