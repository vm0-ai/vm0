/**
 * Public API v1 - Artifact Versions Endpoint
 *
 * GET /v1/artifacts/:id/versions - List artifact versions
 */
import { initServices } from "../../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../../src/lib/public-api/handler";
import { publicArtifactVersionsContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../../src/lib/public-api/auth";
import {
  storages,
  storageVersions,
} from "../../../../../src/db/schema/storage";
import { eq, and, desc, gt } from "drizzle-orm";

const STORAGE_TYPE = "artifact";

const router = tsr.router(publicArtifactVersionsContract, {
  list: async ({ params, query, headers }) => {
    initServices();

    const auth = await authenticatePublicApi(headers.authorization);
    if (!isAuthSuccess(auth)) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message: "Invalid API key provided",
          },
        },
      };
    }

    // Verify artifact exists and belongs to user
    const [artifact] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.id, params.id),
          eq(storages.userId, auth.userId),
          eq(storages.type, STORAGE_TYPE),
        ),
      )
      .limit(1);

    if (!artifact) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such artifact: '${params.id}'`,
          },
        },
      };
    }

    // Build query conditions
    const conditions = [eq(storageVersions.storageId, artifact.id)];

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(storageVersions.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch versions
    const versions = await globalThis.services.db
      .select()
      .from(storageVersions)
      .where(and(...conditions))
      .orderBy(desc(storageVersions.createdAt))
      .limit(limit + 1);

    // Determine pagination info
    const hasMore = versions.length > limit;
    const data = hasMore ? versions.slice(0, limit) : versions;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map((v) => ({
          id: v.id,
          artifact_id: artifact.id,
          size: Number(v.size),
          file_count: v.fileCount,
          message: v.message,
          created_by: v.createdBy,
          created_at: v.createdAt.toISOString(),
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },
});

const handler = createPublicApiHandler(publicArtifactVersionsContract, router);

export { handler as GET };
