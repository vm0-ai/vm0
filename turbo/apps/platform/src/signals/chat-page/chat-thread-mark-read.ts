import { command } from "ccstate";
import { chatThreadMarkReadContract } from "@vm0/api-contracts/contracts/chat-threads";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  applyUnreadSnapshot$,
  recordOptimisticReadMark$,
} from "./sidebar-unread-threads.ts";

interface MarkReadArgs {
  readonly threadId: string;
}

export const markChatThreadRead$ = command(
  async (
    { get, set },
    { threadId }: MarkReadArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    set(recordOptimisticReadMark$, threadId);
    const client = get(zeroClient$)(chatThreadMarkReadContract);
    const result = await accept(
      client.markRead({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(applyUnreadSnapshot$, result.body.unreads);
    return result.body.lastReadAt;
  },
);
