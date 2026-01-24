import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { checkpointsByIdContract } from "@vm0/core";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { checkpoints } from "../../../../../src/db/schema/checkpoint";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";

interface AgentComposeSnapshot {
  agentComposeVersionId: string;
  vars?: Record<string, string>;
  secretNames?: string[];
}

interface ArtifactSnapshot {
  artifactName: string;
  artifactVersion: string;
}

interface VolumeVersionsSnapshot {
  versions: Record<string, string>;
}

const router = tsr.router(checkpointsByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const [checkpoint] = await globalThis.services.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, params.id))
      .limit(1);

    if (!checkpoint) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Checkpoint not found", code: "NOT_FOUND" },
        },
      };
    }

    // Get the run to check authorization
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, checkpoint.runId))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Associated run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check authorization - user can only access their own checkpoints
    if (run.userId !== userId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "You do not have permission to access this checkpoint",
            code: "FORBIDDEN",
          },
        },
      };
    }

    const agentComposeSnapshot =
      checkpoint.agentComposeSnapshot as AgentComposeSnapshot;
    const artifactSnapshot =
      checkpoint.artifactSnapshot as ArtifactSnapshot | null;
    const volumeVersionsSnapshot =
      checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

    return {
      status: 200 as const,
      body: {
        id: checkpoint.id,
        runId: checkpoint.runId,
        conversationId: checkpoint.conversationId,
        agentComposeSnapshot: {
          agentComposeVersionId: agentComposeSnapshot.agentComposeVersionId,
          vars: agentComposeSnapshot.vars,
          secretNames: agentComposeSnapshot.secretNames,
        },
        artifactSnapshot: artifactSnapshot
          ? {
              artifactName: artifactSnapshot.artifactName,
              artifactVersion: artifactSnapshot.artifactVersion,
            }
          : null,
        volumeVersionsSnapshot: volumeVersionsSnapshot
          ? {
              versions: volumeVersionsSnapshot.versions,
            }
          : null,
        createdAt: checkpoint.createdAt.toISOString(),
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: issue.message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(checkpointsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
