import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { storagesDownloadContract } from "@vm0/core/contracts/storages";
import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { initServices } from "../../../../src/lib/init-services";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { isSandboxAuth } from "../../../../src/lib/auth/capability-check";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { generatePresignedUrl } from "../../../../src/lib/infra/s3/s3-client";
import { env } from "../../../../src/env";
import { resolveVersionByPrefix } from "../../../../src/lib/infra/storage/version-resolver";
import { logger } from "../../../../src/lib/shared/logger";

const log = logger("api:storages:download");

const router = tsr.router(storagesDownloadContract, {
  download: async ({ query, headers }) => {
    initServices();

    const { name: storageName, type: storageType, version: versionId } = query;

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

    log.debug(
      `Getting download URL for "${storageName}" (type: ${storageType})${versionId ? ` version ${versionId}` : ""} for org ${runtimeOrg.orgId}`,
    );

    // Volumes use sentinel userId (org-shared); artifacts/memory use real userId
    const storageUserId =
      storageType === "volume" ? VOLUME_ORG_USER_ID : userId;

    // Check if storage exists and belongs to user's default org
    const [storage] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, runtimeOrg.orgId),
          eq(storages.userId, storageUserId),
          eq(storages.name, storageName),
          eq(storages.type, storageType),
        ),
      )
      .limit(1);

    if (!storage) {
      return {
        status: 404 as const,
        body: {
          error: {
            message: `Storage "${storageName}" not found`,
            code: "NOT_FOUND",
          },
        },
      };
    }

    // Determine which version to download
    let version;
    if (versionId) {
      // Resolve version (supports short prefix)
      const resolveResult = await resolveVersionByPrefix(storage.id, versionId);
      if ("error" in resolveResult) {
        const status = resolveResult.status === 404 ? 404 : 400;
        return {
          status: status as 400 | 404,
          body: {
            error: {
              message: resolveResult.error,
              code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
            },
          },
        };
      }
      version = resolveResult.version;
    } else {
      // Use HEAD version
      if (!storage.headVersionId) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Storage "${storageName}" has no versions`,
              code: "NOT_FOUND",
            },
          },
        };
      }

      // Get HEAD version details
      const [headVersion] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return {
          status: 404 as const,
          body: {
            error: {
              message: `Storage "${storageName}" HEAD version not found`,
              code: "NOT_FOUND",
            },
          },
        };
      }
      version = headVersion;
    }

    log.debug(`Generating presigned URL for version ${version.id}`);

    // Handle empty artifact case - return empty flag
    if (version.fileCount === 0) {
      log.debug("Empty artifact, returning empty response");
      return {
        status: 200 as const,
        body: {
          empty: true as const,
          versionId: version.id,
          fileCount: 0 as const,
          size: 0 as const,
        },
      };
    }

    // Generate presigned URL for archive.tar.gz
    const bucketName = env().R2_USER_STORAGES_BUCKET_NAME;
    if (!bucketName) {
      return {
        status: 500 as const,
        body: {
          error: {
            message: "Storage service is not properly configured",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }

    const archiveKey = `${version.s3Key}/archive.tar.gz`;
    // URL valid for 1 hour (3600 seconds)
    const url = await generatePresignedUrl(
      bucketName,
      archiveKey,
      3600,
      undefined,
      true,
    );

    log.debug(`Generated presigned URL for ${archiveKey}`);

    return {
      status: 200 as const,
      body: {
        url,
        versionId: version.id,
        fileCount: version.fileCount,
        size: Number(version.size),
      },
    };
  },
});

const handler = createHandler(storagesDownloadContract, router, {
  routeName: "storages.download",
});

export { handler as GET };
