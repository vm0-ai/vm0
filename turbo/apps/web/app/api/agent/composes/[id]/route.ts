import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { composesByIdContract, getInstructionsStorageName } from "@vm0/core";
import { and, eq, inArray } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
import { storages } from "../../../../../src/db/schema/storage";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { canAccessCompose } from "../../../../../src/lib/agent/compose-access";
import {
  listS3Objects,
  deleteS3Objects,
} from "../../../../../src/lib/s3/s3-client";
import type { AgentComposeYaml } from "../../../../../src/types/agent-compose";

const router = tsr.router(composesByIdContract, {
  getById: async ({ params, headers }) => {
    initServices();

    const authResult = await requireAuth(headers.authorization, {
      requiredCapability: "agent:read",
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    // JOIN compose + version in a single query
    const [result] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        userId: agentComposes.userId,
        orgId: agentComposes.orgId,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
        createdAt: agentComposes.createdAt,
        updatedAt: agentComposes.updatedAt,
        content: agentComposeVersions.content,
      })
      .from(agentComposes)
      .leftJoin(
        agentComposeVersions,
        eq(agentComposes.headVersionId, agentComposeVersions.id),
      )
      .where(eq(agentComposes.id, params.id))
      .limit(1);

    if (!result) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check permission to access this compose
    const hasAccess = await canAccessCompose(userId, result);
    if (!hasAccess) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent compose not found", code: "NOT_FOUND" },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        id: result.id,
        name: result.name,
        headVersionId: result.headVersionId,
        content: (result.content as AgentComposeYaml) ?? null,
        createdAt: result.createdAt.toISOString(),
        updatedAt: result.updatedAt.toISOString(),
      },
    };
  },

  delete: async ({ params, headers }) => {
    initServices();

    // 1. Authenticate
    const authResult = await requireAuth(headers.authorization, {
      requiredCapability: "agent:write",
    });
    if (isAuthError(authResult)) return authResult;
    const { userId } = authResult;

    // 2. Verify ownership (only owner can delete)
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, params.id), eq(agentComposes.userId, userId)),
      )
      .limit(1);

    if (!compose) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        },
      };
    }

    // 3. Check for running/pending runs
    const runningRuns = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        agentComposeVersions,
        eq(agentRuns.agentComposeVersionId, agentComposeVersions.id),
      )
      .where(
        and(
          eq(agentComposeVersions.composeId, params.id),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1);

    if (runningRuns.length > 0) {
      return {
        status: 409 as const,
        body: {
          error: {
            message: "Cannot delete agent: agent is currently running",
            code: "CONFLICT",
          },
        },
      };
    }

    // 4. Delete agent (cascades handle related data)
    await globalThis.services.db
      .delete(agentComposes)
      .where(eq(agentComposes.id, params.id));

    // 5. Clean up agent-instructions volume (DB + S3)
    const storageName = getInstructionsStorageName(compose.name);
    const [storage] = await globalThis.services.db
      .select({ id: storages.id, s3Prefix: storages.s3Prefix })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, compose.orgId),
          eq(storages.name, storageName),
          eq(storages.type, "volume"),
        ),
      )
      .limit(1);

    if (storage) {
      // Delete DB record (CASCADE removes storage_versions)
      await globalThis.services.db
        .delete(storages)
        .where(eq(storages.id, storage.id));

      // Delete S3 objects under the storage prefix
      const bucketName = globalThis.services.env.R2_USER_STORAGES_BUCKET_NAME;
      const objects = await listS3Objects(bucketName, storage.s3Prefix);
      if (objects.length > 0) {
        await deleteS3Objects(
          bucketName,
          objects.map((o) => o.key),
        );
      }
    }

    return { status: 204 as const, body: undefined };
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

const handler = createHandler(composesByIdContract, router, {
  errorHandler,
});

export { handler as GET, handler as DELETE };
