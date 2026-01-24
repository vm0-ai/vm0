import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { storagesListContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { storages } from "../../../../src/db/schema/storage";
import { eq, and, desc } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:list");

const router = tsr.router(storagesListContract, {
  list: async ({ query, headers }) => {
    initServices();

    // Authenticate user
    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    const { type: storageType } = query;

    log.debug(`Listing ${storageType}s for user ${userId}`);

    // Query storages filtered by user and type
    const results = await globalThis.services.db
      .select({
        name: storages.name,
        size: storages.size,
        fileCount: storages.fileCount,
        updatedAt: storages.updatedAt,
      })
      .from(storages)
      .where(and(eq(storages.userId, userId), eq(storages.type, storageType)))
      .orderBy(desc(storages.updatedAt));

    log.debug(`Found ${results.length} ${storageType}s`);

    return {
      status: 200 as const,
      body: results.map((r) => ({
        name: r.name,
        size: r.size,
        fileCount: r.fileCount,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  // Log unexpected errors
  log.error("List error:", err);
  return TsRestResponse.fromJson(
    {
      error: {
        message: err instanceof Error ? err.message : "List failed",
        code: "INTERNAL_ERROR",
      },
    },
    { status: 500 },
  );
}

const handler = createHandler(storagesListContract, router, {
  errorHandler,
});

export { handler as GET };
