import { gzipSync } from "node:zlib";

import type { StorageManifest } from "@vm0/api-contracts/contracts/runners";
import {
  expandVariablesInString,
  getInstructionsFilename,
  getInstructionsStorageName,
  MIN_VERSION_PREFIX_LENGTH,
  SYSTEM_ORG_ID,
  type SupportedFramework,
  VOLUME_ORG_USER_ID,
} from "@vm0/core";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import type { Getter } from "ccstate";
import { and, eq, like } from "drizzle-orm";

import { env } from "../../lib/env";
import { generatePresignedGetUrl, putS3Object } from "../external/s3";
import type { Db } from "../external/db";
import { nowDate } from "../external/time";
import { safeAsync } from "../utils";
import { computeContentHashFromHashes } from "./storage-content-hash.service";

type ComputedGetter = Getter;
type StorageType = "artifact" | "volume";
type ManifestStorage = StorageManifest["storages"][number];
type ManifestArtifact = StorageManifest["artifacts"][number];

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
}

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
}

interface VolumeConfig {
  readonly name: string;
  readonly version: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface AgentConfig {
  readonly framework?: string;
  readonly volumes?: readonly string[];
  readonly instructions?: unknown;
}

interface AgentComposeContent {
  readonly agent?: AgentConfig;
  readonly agents?: Record<string, AgentConfig | undefined>;
  readonly volumes?: Record<string, VolumeConfig | undefined>;
}

interface ResolvedVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly vasVersion: string;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface StorageResolution {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Key: string;
}

interface StorageLookup {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: StorageType;
}

const EMPTY_TAR_GZ = gzipSync(Buffer.alloc(1024, 0));
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

function instructionsMountPath(framework: SupportedFramework): string {
  return framework === "codex" ? "/home/user/.codex" : "/home/user/.claude";
}

function firstAgentEntry(
  content: AgentComposeContent,
): { readonly name: string | undefined; readonly agent: AgentConfig } | null {
  if (content.agent) {
    return { name: undefined, agent: content.agent };
  }

  const firstEntry = Object.entries(content.agents ?? {})[0];
  if (!firstEntry?.[1]) {
    return null;
  }
  return { name: firstEntry[0], agent: firstEntry[1] };
}

function parseVolumeDeclaration(declaration: string): {
  readonly name: string;
  readonly mountPath: string;
} {
  const [name, mountPath, extra] = declaration.split(":");
  if (extra !== undefined || !name?.trim() || !mountPath?.trim()) {
    throw new Error(
      `Invalid volume declaration: ${declaration}. Expected format: volume-name:/mount/path`,
    );
  }
  return { name: name.trim(), mountPath: mountPath.trim() };
}

function expandTemplate(
  value: string,
  vars: Record<string, string> | undefined,
  context: string,
): string {
  const { result, missingVars } = expandVariablesInString(value, {
    vars: vars ?? {},
  });
  if (missingVars.length > 0) {
    throw new Error(
      `${context} is missing required variables: ${missingVars
        .map((ref) => {
          return ref.name;
        })
        .join(", ")}`,
    );
  }
  return result;
}

function resolveComposeVolumes(args: {
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly framework: SupportedFramework;
}): readonly ResolvedVolume[] {
  const entry = firstAgentEntry(args.content);
  if (!entry) {
    return [];
  }

  const resolved: ResolvedVolume[] = [];
  for (const declaration of entry.agent.volumes ?? []) {
    const parsed = parseVolumeDeclaration(declaration);
    const config = args.content.volumes?.[parsed.name];
    if (!config) {
      throw new Error(
        `Volume "${parsed.name}" is not defined in the volumes section`,
      );
    }

    const versionOverride = args.volumeVersionOverrides?.[parsed.name];
    resolved.push({
      name: parsed.name,
      mountPath: parsed.mountPath,
      vasStorageName: expandTemplate(
        config.name,
        args.vars,
        `Volume "${parsed.name}" name`,
      ),
      vasVersion: expandTemplate(
        versionOverride ?? config.version,
        args.vars,
        `Volume "${parsed.name}" version`,
      ),
      optional: config.optional,
      system: config.system,
    });
  }

  if (entry.agent.instructions && entry.name) {
    const storageName = getInstructionsStorageName(entry.name);
    resolved.push({
      name: storageName,
      mountPath: instructionsMountPath(args.framework),
      vasStorageName: storageName,
      vasVersion: "latest",
      instructionsTargetFilename: getInstructionsFilename(args.framework),
    });
  }

  return resolved;
}

function dedupArtifacts(
  artifacts: readonly ContextArtifact[],
): readonly ContextArtifact[] {
  const byName = new Map<string, ContextArtifact>();
  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact);
  }
  return [...byName.values()];
}

function createEmptyStorageManifest(): string {
  return JSON.stringify({
    version: "1",
    createdAt: nowDate().toISOString(),
    totalSize: 0,
    fileCount: 0,
    files: [],
  });
}

async function findStorage(
  db: Db,
  lookup: StorageLookup,
): Promise<
  | {
      readonly id: string;
      readonly headVersionId: string | null;
      readonly s3Prefix: string;
    }
  | undefined
> {
  const [storage] = await db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, lookup.orgId),
        eq(storages.userId, lookup.userId),
        eq(storages.name, lookup.name),
        eq(storages.type, lookup.type),
      ),
    )
    .limit(1);
  return storage;
}

async function ensureArtifactStorage(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly bucket: string;
}): Promise<void> {
  const lookup = {
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    type: "artifact" as const,
  };
  let storage = await findStorage(args.db, lookup);

  if (!storage) {
    const [created] = await args.db
      .insert(storages)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name: args.name,
        type: "artifact",
        s3Prefix: `${args.orgId}/artifact/${args.name}`,
      })
      .onConflictDoNothing()
      .returning({
        id: storages.id,
        headVersionId: storages.headVersionId,
        s3Prefix: storages.s3Prefix,
      });
    storage = created ?? (await findStorage(args.db, lookup));
  }

  if (!storage) {
    throw new Error(`Failed to create artifact storage "${args.name}"`);
  }
  if (storage.headVersionId) {
    return;
  }

  const versionId = computeContentHashFromHashes(storage.id, []);
  const s3Key = `${storage.s3Prefix}/${versionId}`;
  await Promise.all([
    args.get(
      putS3Object(
        args.bucket,
        `${s3Key}/manifest.json`,
        createEmptyStorageManifest(),
        "application/json",
      ),
    ),
    args.get(
      putS3Object(
        args.bucket,
        `${s3Key}/archive.tar.gz`,
        EMPTY_TAR_GZ,
        "application/gzip",
      ),
    ),
  ]);

  await args.db.transaction(async (tx) => {
    await tx
      .insert(storageVersions)
      .values({
        id: versionId,
        storageId: storage.id,
        s3Key,
        size: 0,
        fileCount: 0,
        message: "Initial empty artifact",
        createdBy: args.userId,
      })
      .onConflictDoNothing();
    await tx
      .update(storages)
      .set({
        headVersionId: versionId,
        size: 0,
        fileCount: 0,
        updatedAt: nowDate(),
      })
      .where(eq(storages.id, storage.id));
  });
}

export async function ensureUserArtifactStorage(args: {
  readonly get: Getter;
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly bucket: string;
}): Promise<void> {
  await ensureArtifactStorage(args);
}

async function resolveLatestVersion(
  db: Db,
  lookup: StorageLookup,
): Promise<StorageResolution> {
  const [row] = await db
    .select({
      storageId: storages.id,
      headVersionId: storages.headVersionId,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
    })
    .from(storages)
    .leftJoin(storageVersions, eq(storages.headVersionId, storageVersions.id))
    .where(
      and(
        eq(storages.orgId, lookup.orgId),
        eq(storages.userId, lookup.userId),
        eq(storages.name, lookup.name),
        eq(storages.type, lookup.type),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  if (!row.headVersionId) {
    throw new Error(`Storage "${lookup.name}" has no HEAD version`);
  }
  if (!row.versionId || !row.s3Key) {
    throw new Error(`Storage "${lookup.name}" HEAD version not found`);
  }

  return {
    storageId: row.storageId,
    versionId: row.versionId,
    s3Key: row.s3Key,
  };
}

async function resolvePinnedVersion(
  db: Db,
  lookup: StorageLookup,
  version: string,
): Promise<StorageResolution> {
  const storage = await findStorage(db, lookup);
  if (!storage) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }

  const [exactMatch] = await db
    .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        eq(storageVersions.id, version),
      ),
    )
    .limit(1);
  if (exactMatch) {
    return {
      storageId: storage.id,
      versionId: exactMatch.id,
      s3Key: exactMatch.s3Key,
    };
  }

  if (
    version.length < MIN_VERSION_PREFIX_LENGTH ||
    !/^[a-f0-9]+$/i.test(version)
  ) {
    throw new Error(
      `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
    );
  }

  const matches = await db
    .select({ id: storageVersions.id, s3Key: storageVersions.s3Key })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.id),
        like(storageVersions.id, `${version}%`),
      ),
    )
    .limit(2);
  if (matches.length === 0) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous version prefix "${version}" for storage "${lookup.name}". Please use more characters.`,
    );
  }

  const match = matches[0];
  if (!match) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  return { storageId: storage.id, versionId: match.id, s3Key: match.s3Key };
}

function resolveStorageVersion(
  db: Db,
  lookup: StorageLookup,
  version: string | undefined,
): Promise<StorageResolution> {
  return version === undefined || version === "latest"
    ? resolveLatestVersion(db, lookup)
    : resolvePinnedVersion(db, lookup, version);
}

function isMissingStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("not found in database") ||
      error.message.includes("has no HEAD version"))
  );
}

function volumeStorageName(volume: ResolvedVolume | AdditionalVolume): string {
  return "vasStorageName" in volume ? volume.vasStorageName : volume.name;
}

function volumeVersion(
  volume: ResolvedVolume | AdditionalVolume,
): string | undefined {
  return "vasVersion" in volume ? volume.vasVersion : volume.version;
}

async function resolveVolumeStorage(args: {
  readonly db: Db;
  readonly volume: ResolvedVolume | AdditionalVolume;
  readonly primaryOrgId: string;
  readonly allowSystemFallback: boolean;
}): Promise<StorageResolution | null> {
  if (args.allowSystemFallback && args.volume.system) {
    const systemResult = await safeAsync(() => {
      return resolveStorageVersion(
        args.db,
        {
          orgId: SYSTEM_ORG_ID,
          userId: VOLUME_ORG_USER_ID,
          name: volumeStorageName(args.volume),
          type: "volume",
        },
        volumeVersion(args.volume),
      );
    });
    if ("ok" in systemResult) {
      return systemResult.ok;
    }
    if (!isMissingStorageError(systemResult.error)) {
      throw systemResult.error;
    }
  }

  return await resolveStorageVersion(
    args.db,
    {
      orgId: args.primaryOrgId,
      userId: VOLUME_ORG_USER_ID,
      name: volumeStorageName(args.volume),
      type: "volume",
    },
    volumeVersion(args.volume),
  );
}

async function buildStorageEntry(args: {
  readonly get: ComputedGetter;
  readonly bucket: string;
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly instructionsTargetFilename?: string;
  readonly resolved: StorageResolution;
}): Promise<ManifestStorage> {
  const archiveUrl = await args.get(
    generatePresignedGetUrl(
      args.bucket,
      `${args.resolved.s3Key}/archive.tar.gz`,
      DOWNLOAD_URL_TTL_SECONDS,
      undefined,
      true,
    ),
  );
  return {
    name: args.name,
    mountPath: args.mountPath,
    vasStorageName: args.vasStorageName,
    vasVersionId: args.resolved.versionId,
    ...(args.instructionsTargetFilename
      ? { instructionsTargetFilename: args.instructionsTargetFilename }
      : {}),
    archiveUrl,
  };
}

async function buildComposeStorageEntry(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
}): Promise<ManifestStorage | null> {
  const resolvedResult = await safeAsync(() => {
    return resolveVolumeStorage({
      db: args.db,
      volume: args.volume,
      primaryOrgId: args.agentOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (args.volume.optional && isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return await buildStorageEntry({
    get: args.get,
    bucket: args.bucket,
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.vasStorageName,
    instructionsTargetFilename: args.volume.instructionsTargetFilename,
    resolved: resolvedResult.ok,
  });
}

async function buildAdditionalStorageEntry(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
}): Promise<ManifestStorage | null> {
  const resolvedResult = await safeAsync(() => {
    return resolveVolumeStorage({
      db: args.db,
      volume: args.volume,
      primaryOrgId: args.runtimeOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return await buildStorageEntry({
    get: args.get,
    bucket: args.bucket,
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved: resolvedResult.ok,
  });
}

async function buildArtifactEntry(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly bucket: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
}): Promise<ManifestArtifact> {
  const resolved = await resolveStorageVersion(
    args.db,
    {
      orgId: args.runtimeOrgId,
      userId: args.userId,
      name: args.artifact.name,
      type: "artifact",
    },
    args.artifact.version,
  );
  const [archiveUrl, manifestUrl] = await Promise.all([
    args.get(
      generatePresignedGetUrl(
        args.bucket,
        `${resolved.s3Key}/archive.tar.gz`,
        DOWNLOAD_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    ),
    args.get(
      generatePresignedGetUrl(
        args.bucket,
        `${resolved.s3Key}/manifest.json`,
        DOWNLOAD_URL_TTL_SECONDS,
        undefined,
        true,
      ),
    ),
  ]);

  return {
    mountPath: args.artifact.mountPath,
    vasStorageName: args.artifact.name,
    vasStorageId: resolved.storageId,
    vasVersionId: resolved.versionId,
    archiveUrl,
    manifestUrl,
  };
}

function mergeStorageEntries(args: {
  readonly composeEntries: readonly ManifestStorage[];
  readonly additionalEntries: readonly ManifestStorage[];
}): readonly ManifestStorage[] {
  const additionalMountPaths = new Set(
    args.additionalEntries.map((entry) => {
      return entry.mountPath;
    }),
  );
  return [
    ...args.composeEntries.filter((entry) => {
      return !additionalMountPaths.has(entry.mountPath);
    }),
    ...args.additionalEntries,
  ];
}

export async function prepareAgentRunStorageManifest(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly content: AgentComposeContent;
  readonly vars: Record<string, string> | undefined;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly framework: SupportedFramework;
}): Promise<StorageManifest> {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const artifacts = dedupArtifacts(args.artifacts);
  const composeVolumes = resolveComposeVolumes({
    content: args.content,
    vars: args.vars,
    volumeVersionOverrides: args.volumeVersionOverrides,
    framework: args.framework,
  });

  await Promise.all(
    artifacts.map((artifact) => {
      return ensureArtifactStorage({
        get: args.get,
        db: args.db,
        orgId: args.runtimeOrgId,
        userId: args.userId,
        name: artifact.name,
        bucket,
      });
    }),
  );

  const [composeEntries, additionalEntries, artifactEntries] =
    await Promise.all([
      Promise.all(
        composeVolumes.map((volume) => {
          return buildComposeStorageEntry({
            get: args.get,
            db: args.db,
            bucket,
            agentOrgId: args.agentOrgId,
            volume,
          });
        }),
      ),
      Promise.all(
        (args.additionalVolumes ?? []).map((volume) => {
          return buildAdditionalStorageEntry({
            get: args.get,
            db: args.db,
            bucket,
            runtimeOrgId: args.runtimeOrgId,
            volume,
          });
        }),
      ),
      Promise.all(
        artifacts.map((artifact) => {
          return buildArtifactEntry({
            get: args.get,
            db: args.db,
            bucket,
            runtimeOrgId: args.runtimeOrgId,
            userId: args.userId,
            artifact,
          });
        }),
      ),
    ]);

  return {
    storages: [
      ...mergeStorageEntries({
        composeEntries: composeEntries.filter(
          (entry): entry is ManifestStorage => {
            return entry !== null;
          },
        ),
        additionalEntries: additionalEntries.filter(
          (entry): entry is ManifestStorage => {
            return entry !== null;
          },
        ),
      }),
    ],
    artifacts: artifactEntries,
  };
}
