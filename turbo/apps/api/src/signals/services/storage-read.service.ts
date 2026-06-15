import { VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { computed, type Computed } from "ccstate";
import { and, desc, eq, like } from "drizzle-orm";

import { env } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import type { AuthContext } from "../../types/auth";
import { db$ } from "../external/db";
import { generatePresignedGetUrl } from "../external/s3";

const DOWNLOAD_URL_TTL_SECONDS = 3600;
const MIN_VERSION_PREFIX_LENGTH = 8;
const VERSION_PREFIX_RE = /^[a-f0-9]{8,64}$/i;

type StorageType = "volume" | "artifact";

type StorageErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly status: 500;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "INTERNAL_ERROR";
        };
      };
    };

interface RuntimeOrg {
  readonly orgId: string;
}

interface ListStorageArgs {
  readonly auth: AuthContext;
  readonly type: StorageType;
}

interface DownloadStorageArgs extends ListStorageArgs {
  readonly name: string;
  readonly version: string | undefined;
}

interface StorageListItem {
  readonly name: string;
  readonly size: number;
  readonly fileCount: number;
  readonly updatedAt: string;
}

type StorageDownloadResponse =
  | {
      readonly status: 200;
      readonly body:
        | {
            readonly url: string;
            readonly versionId: string;
            readonly fileCount: number;
            readonly size: number;
          }
        | {
            readonly empty: true;
            readonly versionId: string;
            readonly fileCount: 0;
            readonly size: 0;
          };
    }
  | StorageErrorResponse;

type StorageListResponse =
  | {
      readonly status: 200;
      readonly body: readonly StorageListItem[];
    }
  | StorageErrorResponse;

type StorageVersion = typeof storageVersions.$inferSelect;

type VersionResolutionResult =
  | { readonly version: StorageVersion }
  | { readonly error: string; readonly status: 400 | 404 };

function hasRunId(auth: AuthContext): auth is AuthContext & {
  readonly runId: string;
} {
  return "runId" in auth && typeof auth.runId === "string";
}

function storageUserId(type: StorageType, userId: string): string {
  return type === "volume" ? VOLUME_ORG_USER_ID : userId;
}

function invalidOrgContext(): ReturnType<typeof badRequestMessage> {
  return badRequestMessage(
    "Explicit org context required — ensure active org in session",
  );
}

function resolveStorageRuntimeOrg(
  auth: AuthContext,
): Computed<Promise<RuntimeOrg | StorageErrorResponse>> {
  return computed(async (get): Promise<RuntimeOrg | StorageErrorResponse> => {
    if (!hasRunId(auth)) {
      return auth.orgId ? { orgId: auth.orgId } : invalidOrgContext();
    }

    const db = get(db$);
    const [run] = await db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, auth.runId), eq(agentRuns.userId, auth.userId)),
      )
      .limit(1);

    if (!run) {
      return notFound("Agent run not found");
    }

    return { orgId: run.orgId };
  });
}

function isValidVersionPrefix(version: string): boolean {
  return VERSION_PREFIX_RE.test(version);
}

function resolveVersionByPrefix(
  storageId: string,
  versionIdOrPrefix: string,
): Computed<Promise<VersionResolutionResult>> {
  return computed(async (get): Promise<VersionResolutionResult> => {
    const db = get(db$);
    const [exactMatch] = await db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storageId),
          eq(storageVersions.id, versionIdOrPrefix),
        ),
      )
      .limit(1);

    if (exactMatch) {
      return { version: exactMatch };
    }

    if (!isValidVersionPrefix(versionIdOrPrefix)) {
      if (versionIdOrPrefix.length < MIN_VERSION_PREFIX_LENGTH) {
        return {
          error: `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
          status: 400,
        };
      }
      return {
        error: `Version "${versionIdOrPrefix}" not found`,
        status: 404,
      };
    }

    const prefixMatches = await db
      .select()
      .from(storageVersions)
      .where(
        and(
          eq(storageVersions.storageId, storageId),
          like(storageVersions.id, `${versionIdOrPrefix.toLowerCase()}%`),
        ),
      )
      .limit(2);

    if (prefixMatches.length === 0) {
      return {
        error: `Version "${versionIdOrPrefix}" not found`,
        status: 404,
      };
    }

    if (prefixMatches.length > 1) {
      return {
        error: `Ambiguous version prefix "${versionIdOrPrefix}". Please use more characters.`,
        status: 400,
      };
    }

    const matchedVersion = prefixMatches[0];
    if (!matchedVersion) {
      return {
        error: `Version "${versionIdOrPrefix}" not found`,
        status: 404,
      };
    }

    return { version: matchedVersion };
  });
}

function versionErrorResponse(
  result: Extract<VersionResolutionResult, { readonly error: string }>,
): StorageErrorResponse {
  if (result.status === 404) {
    return notFound(result.error);
  }

  return badRequestMessage(result.error);
}

function storageServiceNotConfigured(): StorageErrorResponse {
  return {
    status: 500,
    body: {
      error: {
        message: "Storage service is not properly configured",
        code: "INTERNAL_ERROR",
      },
    },
  };
}

export function listStoragesForAuth({
  auth,
  type,
}: ListStorageArgs): Computed<Promise<StorageListResponse>> {
  return computed(async (get): Promise<StorageListResponse> => {
    const runtimeOrg = await get(resolveStorageRuntimeOrg(auth));
    if ("status" in runtimeOrg) {
      return runtimeOrg;
    }

    const db = get(db$);
    const rows = await db
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
          eq(storages.userId, storageUserId(type, auth.userId)),
          eq(storages.type, type),
        ),
      )
      .orderBy(desc(storages.updatedAt));

    return {
      status: 200,
      body: rows.map((row) => {
        return {
          name: row.name,
          size: row.size,
          fileCount: row.fileCount,
          updatedAt: row.updatedAt.toISOString(),
        };
      }),
    };
  });
}

export function downloadStorageForAuth({
  auth,
  name,
  type,
  version,
}: DownloadStorageArgs): Computed<Promise<StorageDownloadResponse>> {
  return computed(async (get): Promise<StorageDownloadResponse> => {
    const runtimeOrg = await get(resolveStorageRuntimeOrg(auth));
    if ("status" in runtimeOrg) {
      return runtimeOrg;
    }

    const db = get(db$);
    const [storage] = await db
      .select()
      .from(storages)
      .where(
        and(
          eq(storages.orgId, runtimeOrg.orgId),
          eq(storages.userId, storageUserId(type, auth.userId)),
          eq(storages.name, name),
          eq(storages.type, type),
        ),
      )
      .limit(1);

    if (!storage) {
      return notFound(`Storage "${name}" not found`);
    }

    let resolvedVersion: StorageVersion;
    if (version) {
      const result = await get(resolveVersionByPrefix(storage.id, version));
      if ("error" in result) {
        return versionErrorResponse(result);
      }
      resolvedVersion = result.version;
    } else {
      if (!storage.headVersionId) {
        return notFound(`Storage "${name}" has no versions`);
      }

      const [headVersion] = await db
        .select()
        .from(storageVersions)
        .where(eq(storageVersions.id, storage.headVersionId))
        .limit(1);

      if (!headVersion) {
        return notFound(`Storage "${name}" HEAD version not found`);
      }

      resolvedVersion = headVersion;
    }

    if (resolvedVersion.fileCount === 0) {
      return {
        status: 200,
        body: {
          empty: true,
          versionId: resolvedVersion.id,
          fileCount: 0,
          size: 0,
        },
      };
    }

    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    if (!bucket) {
      return storageServiceNotConfigured();
    }

    const archiveKey = `${resolvedVersion.s3Key}/archive.tar.gz`;
    const url = await get(
      generatePresignedGetUrl(
        bucket,
        archiveKey,
        DOWNLOAD_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    );

    return {
      status: 200,
      body: {
        url,
        versionId: resolvedVersion.id,
        fileCount: resolvedVersion.fileCount,
        size: Number(resolvedVersion.size),
      },
    };
  });
}
