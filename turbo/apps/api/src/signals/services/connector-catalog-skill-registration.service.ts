import { createHash } from "node:crypto";

import type { ConnectorCatalogSyncFailureCode } from "@vm0/api-contracts/contracts/cron";
import { SYSTEM_ORG_ID, VOLUME_ORG_USER_ID } from "@vm0/core/storage-names";
import { storages, storageVersions } from "@vm0/db/schema/storage";
import { and, eq, inArray } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import { S3ObjectSizeLimitError } from "../external/s3";
import { safeJsonParse, safeSync, settle } from "../utils";
import {
  CONNECTOR_SKILL_MAX_TOTAL_BYTES,
  CONNECTOR_SKILL_STORAGE_PATH_PREFIX,
  connectorSkillManifestSchema,
  type ConnectorCatalogPrivateArtifact,
} from "./connector-catalog-artifacts/artifacts";
import type { ConnectorCatalogArtifactReader } from "./connector-catalog-artifacts/loader";

const CONNECTOR_SKILL_MANIFEST_MAX_BYTES = 128 * 1024;
const CONNECTOR_SKILL_ARCHIVE_MAX_BYTES = CONNECTOR_SKILL_MAX_TOTAL_BYTES * 2;
const SYSTEM_STORAGE_CREATOR = "system";

type PrivateConnector = ConnectorCatalogPrivateArtifact["connectors"][number];
type BundledConnectorSkill = Extract<
  PrivateConnector["skill"],
  { readonly kind: "bundled" }
>;

interface ExistingStorageVersion {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly type: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly message: string | null;
  readonly createdBy: string;
}

interface StorageIdentity {
  readonly id: string;
  readonly s3Prefix: string;
}

interface ConnectorSkillIdentity {
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
}

export interface PreparedConnectorSkillRegistration {
  readonly storageName: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly size: number;
  readonly archiveSize: number;
  readonly fileCount: number;
}

export interface ConnectorCatalogSkillFailure {
  readonly code: ConnectorCatalogSyncFailureCode;
  readonly cacheable: boolean;
}

class ConnectorCatalogSkillError extends Error {
  constructor(readonly failure: ConnectorCatalogSkillFailure) {
    super(failure.code);
    this.name = "ConnectorCatalogSkillError";
  }
}

export function connectorCatalogSkillFailure(
  error: unknown,
): ConnectorCatalogSkillFailure | undefined {
  return error instanceof ConnectorCatalogSkillError
    ? error.failure
    : undefined;
}

function fail(
  code: ConnectorCatalogSyncFailureCode,
  cacheable: boolean,
): never {
  throw new ConnectorCatalogSkillError({ code, cacheable });
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function skillIdentity(skill: BundledConnectorSkill): ConnectorSkillIdentity {
  const s3Prefix = `${CONNECTOR_SKILL_STORAGE_PATH_PREFIX}/${skill.storageName}`;
  return {
    storageName: skill.storageName,
    versionId: skill.versionId,
    s3Prefix,
    s3Key: `${s3Prefix}/${skill.versionId}`,
  };
}

function reusableExistingVersion(
  existing: ExistingStorageVersion,
  identity: ConnectorSkillIdentity,
): PreparedConnectorSkillRegistration | undefined {
  if (
    existing.orgId !== SYSTEM_ORG_ID ||
    existing.userId !== VOLUME_ORG_USER_ID ||
    existing.name !== identity.storageName ||
    existing.type !== "volume" ||
    existing.s3Prefix !== identity.s3Prefix ||
    existing.s3Key !== identity.s3Key ||
    existing.message !== null ||
    existing.createdBy !== SYSTEM_STORAGE_CREATOR
  ) {
    return undefined;
  }
  return {
    ...identity,
    size: existing.size,
    archiveSize: existing.archiveSize,
    fileCount: existing.fileCount,
  };
}

async function readExistingVersions(
  db: ReadonlyDb,
  versionIds: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, ExistingStorageVersion>> {
  if (versionIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      id: storageVersions.id,
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      type: storages.type,
      s3Prefix: storages.s3Prefix,
      s3Key: storageVersions.s3Key,
      size: storageVersions.size,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
      message: storageVersions.message,
      createdBy: storageVersions.createdBy,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storageVersions.storageId, storages.id))
    .where(inArray(storageVersions.id, [...new Set(versionIds)]));
  signal.throwIfAborted();
  return new Map(
    rows.map((row) => {
      return [row.id, row] as const;
    }),
  );
}

async function readSkillObject(
  reader: ConnectorCatalogArtifactReader,
  key: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const result = await settle(reader.readArtifact(key, maxBytes), signal);
  if (!result.ok) {
    if (result.error instanceof S3ObjectSizeLimitError) {
      fail("object-too-large", true);
    }
    fail("source-unavailable", false);
  }
  const bytes = Buffer.from(result.value);
  if (bytes.length > maxBytes) {
    fail("object-too-large", true);
  }
  return bytes;
}

function parseSkillManifest(bytes: Uint8Array) {
  const decoded = safeSync(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  });
  if (!("ok" in decoded)) {
    fail("invalid-json", true);
  }
  const value = safeJsonParse(decoded.ok);
  if (value === undefined) {
    fail("invalid-json", true);
  }
  const parsed = connectorSkillManifestSchema.safeParse(value);
  if (!parsed.success) {
    fail("invalid-artifact", true);
  }
  return parsed.data;
}

async function verifySkill(
  reader: ConnectorCatalogArtifactReader,
  skill: BundledConnectorSkill,
  signal: AbortSignal,
): Promise<PreparedConnectorSkillRegistration> {
  const [manifestBytes, archiveBytes] = await Promise.all([
    readSkillObject(
      reader,
      skill.manifest.key,
      CONNECTOR_SKILL_MANIFEST_MAX_BYTES,
      signal,
    ),
    readSkillObject(
      reader,
      skill.archive.key,
      CONNECTOR_SKILL_ARCHIVE_MAX_BYTES,
      signal,
    ),
  ]);
  signal.throwIfAborted();
  if (
    digest(manifestBytes) !== skill.manifest.digest ||
    digest(archiveBytes) !== skill.archive.digest
  ) {
    fail("digest-mismatch", true);
  }
  if (archiveBytes.length === 0) {
    fail("invalid-artifact", true);
  }
  const manifest = parseSkillManifest(manifestBytes);
  return {
    ...skillIdentity(skill),
    size: manifest.files.reduce((total, file) => {
      return total + file.size;
    }, 0),
    archiveSize: archiveBytes.length,
    fileCount: manifest.files.length,
  };
}

export async function prepareConnectorCatalogSkills(args: {
  readonly db: ReadonlyDb;
  readonly reader: ConnectorCatalogArtifactReader;
  readonly privateArtifact: ConnectorCatalogPrivateArtifact;
  readonly signal: AbortSignal;
}): Promise<readonly PreparedConnectorSkillRegistration[]> {
  const bundledSkills = args.privateArtifact.connectors.flatMap((connector) => {
    return connector.skill.kind === "bundled" ? [connector.skill] : [];
  });
  const existingByVersion = await readExistingVersions(
    args.db,
    bundledSkills.map((skill) => {
      return skill.versionId;
    }),
    args.signal,
  );
  const prepared: PreparedConnectorSkillRegistration[] = [];
  for (const skill of bundledSkills) {
    const existing = existingByVersion.get(skill.versionId);
    if (existing) {
      const reusable = reusableExistingVersion(existing, skillIdentity(skill));
      if (!reusable) {
        fail("invalid-reference", false);
      }
      prepared.push(reusable);
      continue;
    }
    prepared.push(await verifySkill(args.reader, skill, args.signal));
  }
  return prepared;
}

async function readStorageVersion(
  db: Db,
  versionId: string,
  signal: AbortSignal,
): Promise<ExistingStorageVersion | undefined> {
  const versions = await readExistingVersions(db, [versionId], signal);
  return versions.get(versionId);
}

async function loadOrCreateStorage(
  db: Db,
  registration: PreparedConnectorSkillRegistration,
  signal: AbortSignal,
): Promise<StorageIdentity> {
  const [created] = await db
    .insert(storages)
    .values({
      orgId: SYSTEM_ORG_ID,
      userId: VOLUME_ORG_USER_ID,
      name: registration.storageName,
      type: "volume",
      s3Prefix: registration.s3Prefix,
      size: registration.size,
      fileCount: registration.fileCount,
    })
    .onConflictDoNothing()
    .returning({ id: storages.id, s3Prefix: storages.s3Prefix });
  signal.throwIfAborted();
  if (created) {
    return created;
  }

  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, SYSTEM_ORG_ID),
        eq(storages.userId, VOLUME_ORG_USER_ID),
        eq(storages.name, registration.storageName),
        eq(storages.type, "volume"),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!storage) {
    throw new Error("Connector skill storage was not created");
  }
  return storage;
}

function existingVersionMatchesRegistration(
  existing: ExistingStorageVersion,
  registration: PreparedConnectorSkillRegistration,
): boolean {
  const reusable = reusableExistingVersion(existing, {
    storageName: registration.storageName,
    versionId: registration.versionId,
    s3Prefix: registration.s3Prefix,
    s3Key: registration.s3Key,
  });
  return (
    reusable !== undefined &&
    reusable.size === registration.size &&
    reusable.archiveSize === registration.archiveSize &&
    reusable.fileCount === registration.fileCount
  );
}

async function insertStorageVersion(
  db: Db,
  storageId: string,
  registration: PreparedConnectorSkillRegistration,
  signal: AbortSignal,
): Promise<boolean> {
  const [inserted] = await db
    .insert(storageVersions)
    .values({
      id: registration.versionId,
      storageId,
      s3Key: registration.s3Key,
      size: registration.size,
      archiveSize: registration.archiveSize,
      fileCount: registration.fileCount,
      message: null,
      createdBy: SYSTEM_STORAGE_CREATOR,
    })
    .onConflictDoNothing()
    .returning({ id: storageVersions.id });
  signal.throwIfAborted();
  return inserted !== undefined;
}

async function registerConnectorCatalogSkill(
  db: Db,
  registration: PreparedConnectorSkillRegistration,
  signal: AbortSignal,
): Promise<void> {
  const existing = await readStorageVersion(db, registration.versionId, signal);
  if (existing) {
    if (!existingVersionMatchesRegistration(existing, registration)) {
      fail("invalid-reference", false);
    }
    return;
  }

  const storage = await loadOrCreateStorage(db, registration, signal);
  if (storage.s3Prefix !== registration.s3Prefix) {
    fail("invalid-reference", false);
  }
  const inserted = await insertStorageVersion(
    db,
    storage.id,
    registration,
    signal,
  );
  if (!inserted) {
    const raced = await readStorageVersion(db, registration.versionId, signal);
    if (!raced || !existingVersionMatchesRegistration(raced, registration)) {
      fail("invalid-reference", false);
    }
    return;
  }

  await db
    .update(storages)
    .set({
      headVersionId: registration.versionId,
      size: registration.size,
      fileCount: registration.fileCount,
      updatedAt: nowDate(),
    })
    .where(eq(storages.id, storage.id));
  signal.throwIfAborted();
}

export async function registerPreparedConnectorCatalogSkills(args: {
  readonly db: Db;
  readonly registrations: readonly PreparedConnectorSkillRegistration[];
  readonly signal: AbortSignal;
}): Promise<void> {
  for (const registration of args.registrations) {
    await registerConnectorCatalogSkill(args.db, registration, args.signal);
  }
}
