/**
 * Public API v1 - Volumes Endpoints
 *
 * GET /v1/volumes - List volumes
 * POST /v1/volumes - Create volume
 */
import { initServices } from "../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../src/lib/public-api/handler";
import { publicVolumesListContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../src/lib/scope/scope-service";
import { storages } from "../../../src/db/schema/storage";
import { eq, and, desc, gt } from "drizzle-orm";

const STORAGE_TYPE = "volume";

const router = tsr.router(publicVolumesListContract, {
  list: async ({ query }) => {
    initServices();

    const auth = await authenticatePublicApi();
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

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Build query conditions - filter by user and type
    const conditions = [
      eq(storages.userId, auth.userId),
      eq(storages.type, STORAGE_TYPE),
    ];

    // Handle cursor-based pagination
    if (query.cursor) {
      conditions.push(gt(storages.id, query.cursor));
    }

    const limit = query.limit ?? 20;

    // Fetch volumes
    const results = await globalThis.services.db
      .select()
      .from(storages)
      .where(and(...conditions))
      .orderBy(desc(storages.createdAt))
      .limit(limit + 1);

    // Determine pagination info
    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor =
      hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return {
      status: 200 as const,
      body: {
        data: data.map((s) => ({
          id: s.id,
          name: s.name,
          current_version_id: s.headVersionId,
          size: Number(s.size),
          file_count: s.fileCount,
          created_at: s.createdAt.toISOString(),
          updated_at: s.updatedAt.toISOString(),
        })),
        pagination: {
          has_more: hasMore,
          next_cursor: nextCursor,
        },
      },
    };
  },

  create: async ({ body }) => {
    initServices();

    const auth = await authenticatePublicApi();
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

    // Get user's scope
    const userScope = await getUserScopeByClerkId(auth.userId);
    if (!userScope) {
      return {
        status: 401 as const,
        body: {
          error: {
            type: "authentication_error" as const,
            code: "invalid_api_key",
            message:
              "Please set up your scope first. Login again with: vm0 login",
          },
        },
      };
    }

    // Check if volume with same name exists
    const [existing] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.userId, auth.userId),
          eq(storages.name, body.name),
          eq(storages.type, STORAGE_TYPE),
        ),
      )
      .limit(1);

    if (existing) {
      return {
        status: 409 as const,
        body: {
          error: {
            type: "conflict_error" as const,
            code: "resource_already_exists",
            message: `Volume '${body.name}' already exists`,
          },
        },
      };
    }

    // Create new volume
    const [volume] = await globalThis.services.db
      .insert(storages)
      .values({
        userId: auth.userId,
        name: body.name,
        type: STORAGE_TYPE,
        s3Prefix: `${auth.userId}/${STORAGE_TYPE}/${body.name}`,
        size: 0,
        fileCount: 0,
      })
      .returning();

    if (!volume) {
      return {
        status: 500 as const,
        body: {
          error: {
            type: "api_error" as const,
            code: "internal_error",
            message: "Failed to create volume",
          },
        },
      };
    }

    return {
      status: 201 as const,
      body: {
        id: volume.id,
        name: volume.name,
        current_version_id: volume.headVersionId,
        size: Number(volume.size),
        file_count: volume.fileCount,
        created_at: volume.createdAt.toISOString(),
        updated_at: volume.updatedAt.toISOString(),
        current_version: null,
      },
    };
  },
});

const handler = createPublicApiHandler(publicVolumesListContract, router);

export { handler as GET, handler as POST };
