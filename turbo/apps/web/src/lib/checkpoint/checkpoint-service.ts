import { eq } from "drizzle-orm";
import { agentRuns } from "../../db/schema/agent-run";
import { checkpoints } from "../../db/schema/checkpoint";
import { NotFoundError } from "../errors";
import type { CheckpointRequest, CheckpointResponse } from "./types";

/**
 * Checkpoint Service
 * Manages creation and storage of agent run checkpoints
 */
export class CheckpointService {
  /**
   * Create a checkpoint for an agent run
   *
   * @param request Checkpoint request data from webhook
   * @returns Checkpoint ID and snapshot count
   * @throws NotFoundError if run doesn't exist
   */
  async createCheckpoint(
    request: CheckpointRequest,
  ): Promise<CheckpointResponse> {
    console.log(`[Checkpoint] Creating checkpoint for run ${request.runId}`);

    // Fetch agent run from database
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, request.runId))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    console.log(
      `[Checkpoint] Storing ${request.volumeSnapshots.length} volume snapshot(s)`,
    );

    // Store checkpoint in database
    const [checkpoint] = await globalThis.services.db
      .insert(checkpoints)
      .values({
        runId: request.runId,
        agentConfigId: run.agentConfigId,
        sessionId: request.sessionId,
        dynamicVars: run.dynamicVars,
        sessionHistory: request.sessionHistory,
        volumeSnapshots: request.volumeSnapshots as unknown as Record<
          string,
          unknown
        >,
      })
      .returning();

    if (!checkpoint) {
      throw new Error("Failed to create checkpoint record");
    }

    console.log(
      `[Checkpoint] Checkpoint created successfully: ${checkpoint.id}`,
    );

    return {
      checkpointId: checkpoint.id,
      volumeSnapshots: request.volumeSnapshots.length,
    };
  }
}

// Export singleton instance
export const checkpointService = new CheckpointService();
