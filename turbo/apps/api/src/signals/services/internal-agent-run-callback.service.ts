import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";

import { db$ } from "../external/db";
import { getRunOutputText } from "./run-output.service";
import { saveRunSummary$ } from "./run-summary.service";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";

export const handleAgentInternalCallback$ = command(
  async (
    { get, set },
    callback: InternalRunCallbackEnvelope,
    signal: AbortSignal,
  ): Promise<void> => {
    if (callback.status !== "completed") {
      return;
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

    if (!run) {
      return;
    }

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
  },
);
