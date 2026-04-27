import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { storagesListContract } from "@vm0/api-contracts/contracts/storages";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { initServices } from "../../../../src/lib/init-services";
import { storages } from "@vm0/db/schema/storage";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq, and, desc } from "drizzle-orm";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:storages:list");

const router = tsr.router(storagesListContract, {
  list: async ({ query, headers }) => {
    initServices();

    const { type: storageType } = query;

    const authCtx = await requireAuth(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Resolve org: sandbox tokens use the run's org; CLI/session use resolveOrg
    let runtimeOrg: { orgId: string };
    if (isSandboxAuth(authCtx)) {
      const [run] = await globalThis.services.db
        .select({ orgId: agentRuns.orgId })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.id, authCtx.runId), eq(agentRuns.userId, userId)),
        )
        .limit(1);
      if (!run) {
        return {
          status: 404 as const,
          body: {
            error: { message: "Agent run not found", code: "NOT_FOUND" },
          },
        };
      }
      runtimeOrg = { orgId: run.orgId };
    } else {
      const { org } = await resolveOrg(authCtx);
      runtimeOrg = org;
    }

    // Volumes use sentinel userId (org-shared); artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_ORG_USER_ID : userId;

    log.debug(`Listing ${storageType}s for org ${runtimeOrg.orgId}`);

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
      body: results.map((r) => {
        return {
          name: r.name,
          size: r.size,
          fileCount: r.fileCount,
          updatedAt: r.updatedAt.toISOString(),
        };
      }),
    };
  },
});

const handler = createHandler(storagesListContract, router, {
  routeName: "storages.list",
});

export { handler as GET };
