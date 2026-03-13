import {
  createHandler,
  tsr,
  createSafeErrorHandler,
} from "../../../../src/lib/ts-rest-handler";
import { storagesListContract, VOLUME_SCOPE_USER_ID } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { storages } from "../../../../src/db/schema/storage";
import { eq, and, desc } from "drizzle-orm";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
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
    const { userId, orgId: tokenOrgId } = authCtx;

    const { type: storageType } = query;

    // Resolve user's default org
    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org: runtimeOrg } = await resolveOrg(
      userId,
      orgSlug,
      null,
      tokenOrgId,
    );

    // Volumes use sentinel userId (org-shared); artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_SCOPE_USER_ID : userId;

    log.debug(`Listing ${storageType}s for org ${runtimeOrg.slug}`);

    // Query storages filtered by org, userId, and type
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
          eq(storages.orgId, runtimeOrg.orgId),
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

const handler = createHandler(storagesListContract, router, {
  errorHandler: createSafeErrorHandler("storages:list"),
});

export { handler as GET };
