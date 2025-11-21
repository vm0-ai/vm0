import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentCheckpoints } from "../../../../../../src/db/schema/agent-checkpoint";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../../src/lib/errors";
import { Sandbox } from "@e2b/code-interpreter";
import type { VolumeSnapshot } from "../../../../../../src/db/schema/agent-checkpoint";

/**
 * POST /api/agent/runs/:id/checkpoints
 * Create a checkpoint from current agent run state
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { id: runId } = await params;
    const body = await request.json();
    const { workingDirectory, encodedPath, model } = body;

    if (!workingDirectory || !encodedPath || !model) {
      throw new BadRequestError(
        "Missing required fields: workingDirectory, encodedPath, model",
      );
    }

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    if (run.userId !== userId) {
      throw new UnauthorizedError("Not authorized to access this run");
    }

    if (!run.sessionId) {
      throw new BadRequestError(
        "Run does not have a session ID - cannot create checkpoint",
      );
    }

    if (!run.sandboxId) {
      throw new BadRequestError("Run does not have an active sandbox");
    }

    // Connect to sandbox to download session file
    const sandbox = await Sandbox.connect(run.sandboxId);

    try {
      // Download session JSONL file from sandbox
      const sessionFilePath = `~/.config/claude/projects/${encodedPath}/${run.sessionId}.jsonl`;

      console.log(
        `[Checkpoint] Downloading session file from ${sessionFilePath}`,
      );

      // Read the session file
      const sessionContent = await sandbox.files.read(sessionFilePath);

      if (!sessionContent) {
        throw new BadRequestError(
          `Session file not found at ${sessionFilePath}`,
        );
      }

      console.log(
        `[Checkpoint] Session content retrieved (${sessionContent.length} bytes)`,
      );

      // Extract volume snapshots from run result
      const volumeSnapshots: VolumeSnapshot[] = [];
      if (run.result && typeof run.result === "object") {
        const result = run.result as {
          volumeMetadata?: Array<{
            volumeName: string;
            driver: string;
            commitSha?: string;
            branch?: string;
            repo?: string;
          }>;
        };

        if (result.volumeMetadata) {
          for (const volume of result.volumeMetadata) {
            if (volume.driver === "git") {
              volumeSnapshots.push({
                volumeName: volume.volumeName,
                driver: "git",
                uri: `git://${volume.repo}`,
                commitSha: volume.commitSha,
                branch: volume.branch,
                repo: volume.repo,
              });
            }
          }
        }
      }

      // Create checkpoint record with session content stored in DB
      const [checkpoint] = await globalThis.services.db
        .insert(agentCheckpoints)
        .values({
          runId,
          sessionId: run.sessionId,
          sessionContent: String(sessionContent), // Convert ArrayBuffer/string to string
          volumeSnapshots,
          workingDirectory,
          encodedPath,
          model,
        })
        .returning();

      console.log(
        `[Checkpoint] Created checkpoint ${checkpoint!.id} for run ${runId}`,
      );

      return successResponse(
        {
          checkpointId: checkpoint!.id,
          sessionId: run.sessionId,
          volumeSnapshots,
          sessionSize: sessionContent.length,
        },
        201,
      );
    } finally {
      // Keep sandbox alive - don't close it
      // User may want to continue working or create multiple checkpoints
    }
  } catch (error) {
    console.error("[Checkpoint] Error:", error);
    return errorResponse(error);
  }
}
