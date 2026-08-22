import { command } from "ccstate";
import { chatThreadMarkUnreadContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { reloadChatIndicators$ } from "../chat-thread-list-reload.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import {
  applyUnreadSnapshot$,
  clearOptimisticReadMark$,
} from "./optimistic-chat-thread-read-marks.ts";

interface MarkUnreadArgs {
  readonly threadId: string;
}

export const markChatThreadUnread$ = command(
  async (
    { get, set },
    { threadId }: MarkUnreadArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!(get(featureSwitch$)[FeatureSwitchKey.ChatMarkUnread] ?? false)) {
      return;
    }
    const client = get(apiClient$)(chatThreadMarkUnreadContract);
    const result = await accept(
      client.markUnread({
        params: { id: threadId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(clearOptimisticReadMark$, threadId);
    set(applyUnreadSnapshot$, result.body.unreads);
    set(reloadChatIndicators$);
  },
);
