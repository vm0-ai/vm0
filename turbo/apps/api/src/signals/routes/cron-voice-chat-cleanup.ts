import { cronVoiceChatCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route";
import { resetStuckVoiceChatReasoners$ } from "../services/cron-voice-chat-cleanup.service";
import { triggerVoiceChatReasoning$ } from "../services/zero-voice-chat.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const voiceChatCleanupRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const recoveredReasonerIds = await set(
      resetStuckVoiceChatReasoners$,
      signal,
    );
    signal.throwIfAborted();

    for (const sessionId of recoveredReasonerIds) {
      waitUntil(set(triggerVoiceChatReasoning$, sessionId, signal));
    }

    return {
      status: 200 as const,
      body: {
        success: true as const,
        reasonerReset: recoveredReasonerIds.length,
      },
    };
  },
);

export const cronVoiceChatCleanupRoutes: readonly RouteEntry[] = [
  {
    route: cronVoiceChatCleanupContract.cleanup,
    handler: voiceChatCleanupRoute$,
  },
];
