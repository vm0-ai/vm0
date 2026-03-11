import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { storagesListContract, VOLUME_SCOPE_USER_ID } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { storages } from "../../../../src/db/schema/storage";
import { eq, and, desc } from "drizzle-orm";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveScope } from "../../../../src/lib/scope/resolve-scope";
import { logger } from "../../../../src/lib/logger";

const log = logger("api:storages:list");

const router = tsr.router(storagesListContract, {
  list: async ({ query, headers }, { request }) => {
    initServices();

    // Authenticate user
    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId, scopeId: tokenScopeId } = authCtx;

    const { type: storageType } = query;

    // Resolve user's default scope
    const scopeSlug = new URL(request.url).searchParams.get("scope");
    const orgParam = new URL(request.url).searchParams.get("org");
    const { scope: runtimeScope } = await resolveScope(
      userId,
      scopeSlug,
      orgParam,
      tokenScopeId,
    );

    // Volumes use sentinel userId (scope-shared); artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_SCOPE_USER_ID : userId;

    log.debug(`Listing ${storageType}s for scope ${runtimeScope.slug}`);

    // Query storages filtered by scope, userId, and type
    const results = await globalThis.services.db
      .select({
        name: storages.name,
        size: storages.size,
        fileCount: storages.fileCount,
        updatedAt: storages.updatedAt,
      })
      .from(storages)
      .where(
        and(
          eq(storages.orgId, runtimeScope.orgId),
          eq(storages.userId, storageUserId),
          eq(storages.type, storageType),
        ),
      )
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
