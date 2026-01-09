/**
 * Public API v1 - Artifact by ID Endpoints
 *
 * GET /v1/artifacts/:id - Get artifact details
 * DELETE /v1/artifacts/:id - Delete artifact
 */
import { initServices } from "../../../../src/lib/init-services";
import {
  createPublicApiHandler,
  tsr,
} from "../../../../src/lib/public-api/handler";
import { publicArtifactByIdContract } from "@vm0/core";
import {
  authenticatePublicApi,
  isAuthSuccess,
} from "../../../../src/lib/public-api/auth";
import { storages, storageVersions } from "../../../../src/db/schema/storage";
import { eq, and } from "drizzle-orm";

const STORAGE_TYPE = "artifact";

const router = tsr.router(publicArtifactByIdContract, {
  get: async ({ params }) => {
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

    // Find artifact by ID
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

    // Get current version if exists
    let currentVersion = null;
    if (artifact.headVersionId) {
      const [version] = await globalThis.services.db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, artifact.headVersionId))
        .limit(1);

      if (version) {
        currentVersion = {
          id: version.id,
          artifact_id: artifact.id,
          size: Number(version.size),
          file_count: version.fileCount,
          message: version.message,
          created_by: version.createdBy,
          created_at: version.createdAt.toISOString(),
        };
      }
    }

    return {
      status: 200 as const,
      body: {
        id: artifact.id,
        name: artifact.name,
        current_version_id: artifact.headVersionId,
        size: Number(artifact.size),
        file_count: artifact.fileCount,
        created_at: artifact.createdAt.toISOString(),
        updated_at: artifact.updatedAt.toISOString(),
        current_version: currentVersion,
      },
    };
  },

  delete: async ({ params }) => {
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

    // Find artifact by ID
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

    // Delete all versions first (foreign key constraint)
    await globalThis.services.db
      .delete(storageVersions)
      .where(eq(storageVersions.storageId, artifact.id));

    // Delete the artifact
    await globalThis.services.db
      .delete(storages)
      .where(eq(storages.id, artifact.id));

    return {
      status: 204 as const,
      body: undefined,
    };
  },
});

const handler = createPublicApiHandler(publicArtifactByIdContract, router);

export { handler as GET, handler as DELETE };
