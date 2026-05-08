import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { getRunOutputText } from "../../../../../src/lib/infra/run/extract-run-output";
import { saveRunSummary } from "../../../../../src/lib/zero/run-summary";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:agent");

/**
 * POST /api/internal/callbacks/agent
 *
 * Callback handler for agent-to-agent run completion.
 * Generates a run summary so agent tasks appear with summaries in Mission Control.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback(request, log);
  if (!result.ok) return result.response;

  const { runId, status } = result.data;

  // Ignore progress notifications — only act on terminal states
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  // Only generate summary on successful completion
  if (status === "completed") {
    const [run] = await globalThis.services.db
      .select({
        prompt: agentRuns.prompt,
        lastEventSequence: agentRuns.lastEventSequence,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (run) {
      const resultText = await getRunOutputText(runId, run.lastEventSequence);
      await saveRunSummary(runId, "agent", run.prompt, resultText ?? "");
    }
  }

  return NextResponse.json({ success: true });
}
