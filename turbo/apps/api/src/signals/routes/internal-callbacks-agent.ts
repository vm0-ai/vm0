import { command } from "ccstate";
import { internalCallbacksAgentContract } from "@vm0/api-contracts/contracts/internal-callbacks-agent";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq } from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import type { RouteEntry } from "../route";
import { db$ } from "../external/db";
import { getRunOutputText } from "../services/run-output.service";
import { saveRunSummary$ } from "../services/run-summary.service";

const handleAgentCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const callback = get(callbackPayload$);

    if (callback.status !== "completed") {
      return { status: 200 as const, body: { success: true as const } };
    }

    const db = get(db$);
    const [run] = await db
      .select({
        prompt: agentRuns.prompt,
        lastEventSequence: agentRuns.lastEventSequence,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, callback.runId))
      .limit(1);
    signal.throwIfAborted();

    if (run) {
      const resultText = await getRunOutputText(callback.runId, {
        knownLastEventSequence: run.lastEventSequence,
        signal,
      });
      signal.throwIfAborted();

      await set(
        saveRunSummary$,
        {
          runId: callback.runId,
          triggerSource: "agent",
          prompt: run.prompt,
          resultText: resultText ?? "",
        },
        signal,
      );
      signal.throwIfAborted();
    }

    return { status: 200 as const, body: { success: true as const } };
  },
);

export const internalCallbacksAgentRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksAgentContract.post,
    handler: callbackRoute(handleAgentCallback$),
  },
];
