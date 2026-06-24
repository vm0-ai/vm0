import { command } from "ccstate";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";

export const pauseChatThreadGoal$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const client = get(zeroClient$)(zeroGoalsContract);
    await accept(
      client.pauseForChatThread({
        params: { threadId },
        fetchOptions: { signal },
      }),
      [200],
      { toast: false },
    );
    signal.throwIfAborted();
  },
);
