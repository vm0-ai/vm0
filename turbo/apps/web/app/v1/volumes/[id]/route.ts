/**
 * Public API v1 - Volume by ID Endpoints
 *
 * GET /v1/volumes/:id - Get volume details
 */
import { initServices } from "../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../src/lib/public-api/handler";
import { publicVolumeByIdContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../src/lib/public-api/auth";
import { getUserScopeByClerkId } from "../../../../src/lib/scope/scope-service";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";

const STORAGE_TYPE = "volume";

const router = tsr.router(publicVolumeByIdContract, {
  get: async ({ params, headers }) => {
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

    // Find volume by ID
    const [volume] = await globalThis.services.db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.id, params.id),
          eq(storages.scopeId, userScope.id),
          eq(storages.type, STORAGE_TYPE),
        ),
      )
      .limit(1);

    if (!volume) {
      return {
        status: 404 as const,
        body: {
          error: {
            type: "not_found_error" as const,
            code: "resource_not_found",
            message: `No such volume: '${params.id}'`,
          },
        },
      };
    }

    // Get current version if exists
    let currentVersion = null;
    if (volume.headVersionId) {
      const [version] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, volume.headVersionId))
        .limit(1);

      if (version) {
        currentVersion = {
          id: version.id,
          volumeId: volume.id,
          size: Number(version.size),
          fileCount: version.fileCount,
          message: version.message,
          createdBy: version.createdBy,
          createdAt: version.createdAt.toISOString(),
        };
      }
    }

    return {
      status: 200 as const,
      body: {
        id: volume.id,
        name: volume.name,
        currentVersionId: volume.headVersionId,
        size: Number(volume.size),
        fileCount: volume.fileCount,
        createdAt: volume.createdAt.toISOString(),
        updatedAt: volume.updatedAt.toISOString(),
        currentVersion: currentVersion,
      },
    };
  },
});

const handler = createPublicApiHandler(publicVolumeByIdContract, router);

export { handler as GET };
