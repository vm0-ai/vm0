import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type {
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { hostedDeployments } from "@vm0/db/schema/hosted-site";
import {
  CANONICAL_ASSET_VERSION,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, exists, or } from "drizzle-orm";
import { z } from "zod";
import archiver from "archiver";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import { buildArtifactPrefix } from "../../lib/file-url";
import { db$, type ReadonlyDb } from "../external/db";
import {
  deleteS3Objects,
  downloadHostedSitesS3Buffer,
  downloadS3Buffer,
  downloadS3BufferWithMaxBytes,
  listS3Objects,
} from "../external/s3";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  tapError,
} from "../utils";
import {
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_STATUS_TIMEOUT_MS = 2000;
const GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY = "vm0Artifact";
const GOOGLE_DRIVE_THREAD_APP_PROPERTY = "vm0ThreadId";
const GOOGLE_DRIVE_RUN_APP_PROPERTY = "vm0RunId";
const GOOGLE_DRIVE_FILE_APP_PROPERTY = "vm0FileId";
const GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME = "GOOGLE_DRIVE_TOKEN";

const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});
const driveFileListSchema = z.object({ files: z.array(driveFileSchema) });

interface DriveSyncResult {
  readonly id: string;
  readonly name: string;
  readonly webViewLink: string | null;
}

type DriveStatusLookup =
  | {
      readonly type: "ready";
      readonly syncedByKey: ReadonlyMap<string, DriveSyncResult>;
    }
  | { readonly type: "disconnected" }
  | { readonly type: "unknown" };

interface ConnectorTokens {
  readonly accessToken: string;
  readonly connection: ConnectorCredentialConnection;
  readonly needsReconnect: boolean;
}

function artifactKey(runId: string, fileId: string): string {
  return `${runId}:${fileId}`;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, String.raw`\\`).replace(/'/g, String.raw`\'`);
}

async function threadAllowsGoogleDriveArtifactSync(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly threadId: string;
  },
): Promise<boolean> {
  const [authorization] = await db
    .select({ id: userConnectors.id })
    .from(chatThreads)
    .innerJoin(
      userConnectors,
      and(
        eq(userConnectors.orgId, args.orgId),
        eq(userConnectors.userId, args.userId),
        eq(userConnectors.agentId, chatThreads.agentComposeId),
        eq(userConnectors.connectorType, "google-drive"),
      ),
    )
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return authorization !== undefined;
}

async function loadDriveTokens(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
  featureSwitchContext: FeatureSwitchContext,
  snapshot: ConnectorRuntimeSnapshot,
): Promise<ConnectorTokens | null> {
  const loaded = await loadConnectorCredentialConnection({
    db,
    snapshot,
    orgId,
    userId,
    connectorRef: "google-drive",
  });
  if (loaded.kind !== "ok") {
    return null;
  }
  const connection = loaded.connection;
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    connection,
    GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return null;
  }
  const values = await loadConnectorCredentialValues({
    connection,
    db,
    featureSwitchContext,
    valueRefs: [accessTokenValueRef],
  });
  const accessToken = values.get(accessTokenValueRef);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    connection,
    needsReconnect: connection.needsReconnect,
  };
}

async function refreshDriveAccessToken(args: {
  readonly connection: ConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly orgId: string;
  readonly signal: AbortSignal;
  readonly userId: string;
}): Promise<string | null> {
  const refreshed = await refreshConnectorCredentialAccess({
    connection: args.connection,
    db: args.db,
    featureSwitchContext: args.featureSwitchContext,
    orgId: args.orgId,
    userId: args.userId,
    runtimeEnvironmentName: GOOGLE_DRIVE_ACCESS_TOKEN_ENVIRONMENT_NAME,
    signal: args.signal,
  });
  return refreshed.kind === "ok" ? refreshed.accessToken : null;
}

type DriveListResult =
  | { readonly type: "ok"; readonly files: z.infer<typeof driveFileSchema>[] }
  | { readonly type: "unauthorized" };

async function listArtifactFiles(args: {
  readonly accessToken: string;
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<DriveListResult> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `appProperties has { key='${GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY}' and value='true' }`,
      `appProperties has { key='${GOOGLE_DRIVE_THREAD_APP_PROPERTY}' and value='${escapeQuery(args.threadId)}' }`,
      "trashed = false",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name,webViewLink,appProperties)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal: args.signal,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw new Error(
      `Google Drive lookup failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveFileListSchema.parse(await response.json());
  return { type: "ok", files: parsed.files };
}

async function listArtifactFilesWithRefresh(args: {
  readonly db: ReadonlyDb;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly orgId: string;
  readonly tokens: ConnectorTokens;
  readonly threadId: string;
  readonly signal: AbortSignal;
  readonly userId: string;
}): Promise<z.infer<typeof driveFileSchema>[] | "unauthorized"> {
  const first = await listArtifactFiles({
    accessToken: args.tokens.accessToken,
    threadId: args.threadId,
    signal: args.signal,
  });
  if (first.type === "ok") {
    return first.files;
  }
  const refreshedAccessToken = await refreshDriveAccessToken({
    connection: args.tokens.connection,
    db: args.db,
    featureSwitchContext: args.featureSwitchContext,
    orgId: args.orgId,
    signal: args.signal,
    userId: args.userId,
  });
  if (!refreshedAccessToken) {
    return "unauthorized";
  }
  const second = await listArtifactFiles({
    accessToken: refreshedAccessToken,
    threadId: args.threadId,
    signal: args.signal,
  });
  if (second.type === "unauthorized") {
    return "unauthorized";
  }
  return second.files;
}

function buildStatusMap(
  files: readonly z.infer<typeof driveFileSchema>[],
): ReadonlyMap<string, DriveSyncResult> {
  const map = new Map<string, DriveSyncResult>();
  for (const file of files) {
    const runId = file.appProperties?.[GOOGLE_DRIVE_RUN_APP_PROPERTY];
    const fileId = file.appProperties?.[GOOGLE_DRIVE_FILE_APP_PROPERTY];
    if (!runId || !fileId) {
      continue;
    }
    map.set(artifactKey(runId, fileId), {
      id: file.id,
      name: file.name,
      webViewLink: file.webViewLink ?? null,
    });
  }
  return map;
}

function resolveGoogleDriveArtifactSyncStatus(
  lookup: DriveStatusLookup,
  runId: string,
  fileId: string,
): ChatThreadArtifactGoogleDriveSync {
  if (lookup.type === "disconnected") {
    return { status: "disconnected" };
  }
  if (lookup.type === "unknown") {
    return { status: "unknown" };
  }
  const synced = lookup.syncedByKey.get(artifactKey(runId, fileId));
  return synced ? { status: "synced", ...synced } : { status: "not_synced" };
}

export function applyGoogleDriveArtifactSyncStatuses(
  runs: readonly ChatThreadArtifactRun[],
  lookup: DriveStatusLookup,
): ChatThreadArtifactRun[] {
  return runs.map((run) => {
    return {
      ...run,
      files: run.files.map((file) => {
        return {
          ...file,
          googleDriveSync: resolveGoogleDriveArtifactSyncStatus(
            lookup,
            run.runId,
            file.id,
          ),
        };
      }),
    };
  });
}

/**
 * Compute the Drive sync status lookup for a chat thread's artifacts.
 *
 * Token persistence is intentionally deferred. The selected runtime method is
 * still rechecked through the provider registry, but a successful refresh is
 * used only for this retry and is not written back to connector storage. This
 * keeps the route handler a read-only `computed`. Drive status check is a UI
 * poll, not a hot path; refresh tokens don't rotate (Google), so the cost is
 * one extra RTT per stale-token request.
 * Track in epic #12290 follow-up if telemetry shows this matters.
 */
export function googleDriveArtifactStatusLookup(args: {
  readonly threadId: string;
  readonly orgId: string | undefined;
  readonly userId: string;
}): Computed<Promise<DriveStatusLookup>> {
  return computed(async (get): Promise<DriveStatusLookup> => {
    if (!args.orgId) {
      return { type: "disconnected" };
    }
    const db = get(db$);
    const authorized = await threadAllowsGoogleDriveArtifactSync(db, {
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    if (!authorized) {
      return { type: "disconnected" };
    }
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    const tokens = await loadDriveTokens(
      db,
      args.orgId,
      args.userId,
      featureSwitchContext,
      snapshot,
    );
    if (!tokens || tokens.needsReconnect) {
      return { type: "disconnected" };
    }
    // Schema-parse failure or transient network error — treat as "unknown"
    // rather than failing the whole artifacts response. AbortError from the
    // 2s timeout intentionally propagates under the project-wide ban on
    // swallowing aborts.
    const files = await tapError(
      listArtifactFilesWithRefresh({
        db,
        featureSwitchContext,
        orgId: args.orgId,
        tokens,
        threadId: args.threadId,
        signal: AbortSignal.timeout(GOOGLE_DRIVE_STATUS_TIMEOUT_MS),
        userId: args.userId,
      }),
    );
    if (files === undefined) {
      return { type: "unknown" };
    }
    if (files === "unauthorized") {
      return { type: "unknown" };
    }
    return { type: "ready", syncedByKey: buildStatusMap(files) };
  });
}

// =====================================================================
// Upload-side: sync a single artifact to the user's Google Drive.
// =====================================================================

const driveFolderSchema = z.object({ id: z.string(), name: z.string() });
const driveFolderListSchema = z.object({
  files: z.array(driveFolderSchema),
});
const driveUploadResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
});

const EXT_MIMETYPE_MAP: Readonly<Record<string, string>> = {
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  pdf: "application/pdf",
  html: "text/html",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function inferMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapped = ext ? EXT_MIMETYPE_MAP[ext] : undefined;
  return mapped ?? "application/octet-stream";
}

interface ArtifactFileRow {
  readonly runId: string;
  readonly source: string;
  readonly externalId: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly url: string | null;
  readonly metadata: Record<string, unknown>;
}

interface ArtifactS3Object {
  readonly bucketName: string;
  readonly key: string;
}

interface ResolvedArtifactContent {
  readonly contentType: string;
  readonly file: Buffer;
  readonly filename: string;
}

interface HostedArtifactMetadata {
  readonly artifactKind: "hosted-site" | "presentation-html";
  readonly deploymentId: string;
}

interface ZipEntry {
  readonly path: string;
  readonly content: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostedArtifactMetadata(
  metadata: unknown,
): HostedArtifactMetadata | null {
  if (!isRecord(metadata)) {
    return null;
  }
  if (
    metadata.artifactKind !== "hosted-site" &&
    metadata.artifactKind !== "presentation-html"
  ) {
    return null;
  }
  return typeof metadata.deploymentId === "string"
    ? {
        artifactKind: metadata.artifactKind,
        deploymentId: metadata.deploymentId,
      }
    : null;
}

function hostedSiteFileKey(prefix: string, path: string): string {
  return `${prefix}${path}`;
}

function zipEntryPath(path: string): string {
  const segments = path.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    throw new Error(`Invalid hosted-site path: ${path}`);
  }
  return segments.join("/");
}

async function assembleZip(
  entries: readonly ZipEntry[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = createDeferredPromise<Buffer>(signal);

  archive.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  archive.on("end", () => {
    if (!done.settled()) {
      done.resolve(Buffer.concat(chunks));
    }
  });
  archive.on("error", (error) => {
    if (!done.settled()) {
      done.reject(error);
    }
  });

  const appendResult = safeSync(() => {
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.path });
    }
  });
  if ("error" in appendResult) {
    if (!done.settled()) {
      done.reject(appendResult.error);
    }
    return await done.promise;
  }

  const finalized = (async () => {
    await onRejection(archive.finalize(), (error) => {
      if (!done.settled()) {
        done.reject(error);
      }
    });
    signal.throwIfAborted();
    return await done.promise;
  })();
  return await Promise.race([done.promise, finalized]);
}

async function loadArtifactFile(
  db: ReadonlyDb,
  args: {
    readonly threadId: string;
    readonly runId: string;
    readonly fileId: string;
    readonly userId: string;
  },
): Promise<ArtifactFileRow | null> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.threadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  if (!thread) {
    return null;
  }

  const [row] = await db
    .select({
      runId: runUploadedFiles.runId,
      source: runUploadedFiles.source,
      externalId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      url: runUploadedFiles.url,
      metadata: runUploadedFiles.metadata,
    })
    .from(runUploadedFiles)
    .innerJoin(zeroRuns, eq(zeroRuns.id, runUploadedFiles.runId))
    .where(
      and(
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.runId, args.runId),
        or(
          eq(runUploadedFiles.externalId, args.fileId),
          and(
            eq(runUploadedFiles.id, args.fileId),
            eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
            eq(runUploadedFiles.classification, "published-output"),
            eq(runUploadedFiles.accessLevel, "published"),
          ),
        ),
        or(
          eq(zeroRuns.chatThreadId, args.threadId),
          exists(
            db
              .select({ one: chatMessages.id })
              .from(chatMessages)
              .where(
                and(
                  eq(chatMessages.runId, runUploadedFiles.runId),
                  eq(chatMessages.chatThreadId, args.threadId),
                ),
              ),
          ),
        ),
      ),
    )
    .limit(1);
  if (!row?.runId) {
    return null;
  }
  return { ...row, runId: row.runId };
}

function resolveArtifactS3ObjectFromKey(
  value: string,
  userId: string,
): ArtifactS3Object | null {
  if (value.startsWith(`artifacts/${encodeURIComponent(userId)}/`)) {
    return {
      bucketName: env("R2_USER_ARTIFACTS_BUCKET_NAME"),
      key: value,
    };
  }
  if (!value.startsWith(`uploads/${userId}/`)) {
    return null;
  }
  return {
    bucketName: env("R2_USER_STORAGES_BUCKET_NAME"),
    key: value,
  };
}

function resolveArtifactS3ObjectFromUrl(
  value: string,
  userId: string,
): ArtifactS3Object | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const key = new URL(value).pathname.replace(/^\/+/, "");
  return resolveArtifactS3ObjectFromKey(key, userId);
}

function artifactSourceUrls(artifact: ArtifactFileRow): readonly string[] {
  const metadataSourceUrl = artifact.metadata.sourceUrl;
  return [
    ...(artifact.url ? [artifact.url] : []),
    ...(typeof metadataSourceUrl === "string" &&
    metadataSourceUrl !== artifact.url
      ? [metadataSourceUrl]
      : []),
  ];
}

function resolveArtifactS3Object(
  artifact: ArtifactFileRow,
  userId: string,
): Computed<ArtifactS3Object | null> {
  return computed((): ArtifactS3Object | null => {
    const value = artifact.metadata.s3Key;
    if (typeof value === "string") {
      const s3Object = resolveArtifactS3ObjectFromKey(value, userId);
      if (s3Object) {
        return s3Object;
      }
    }

    for (const sourceUrl of artifactSourceUrls(artifact)) {
      const s3Object = resolveArtifactS3ObjectFromUrl(sourceUrl, userId);
      if (s3Object) {
        return s3Object;
      }
    }

    return null;
  });
}

function resolveHostedArtifactContent(
  db: ReadonlyDb,
  artifact: ArtifactFileRow,
  userId: string,
  signal: AbortSignal,
): Computed<Promise<ResolvedArtifactContent | null>> {
  return computed(async (get): Promise<ResolvedArtifactContent | null> => {
    const metadata = hostedArtifactMetadata(artifact.metadata);
    if (!metadata) {
      return null;
    }

    const bucket = optionalEnv("R2_HOSTED_SITES_BUCKET_NAME");
    if (!bucket) {
      return null;
    }

    const [deployment] = await db
      .select({
        entrypoint: hostedDeployments.entrypoint,
        manifest: hostedDeployments.manifest,
        r2Prefix: hostedDeployments.r2Prefix,
      })
      .from(hostedDeployments)
      .where(
        and(
          eq(hostedDeployments.id, metadata.deploymentId),
          eq(hostedDeployments.userId, userId),
          eq(hostedDeployments.status, "ready"),
        ),
      )
      .limit(1);

    if (!deployment) {
      return null;
    }

    if (metadata.artifactKind === "hosted-site") {
      const entries: ZipEntry[] = [];
      const files = Object.values(deployment.manifest.files).sort((a, b) => {
        return a.path.localeCompare(b.path);
      });
      for (const file of files) {
        const content = await get(
          downloadHostedSitesS3Buffer(
            bucket,
            hostedSiteFileKey(deployment.r2Prefix, file.path),
          ),
        );
        entries.push({ path: zipEntryPath(file.path), content });
      }
      return {
        contentType: "application/zip",
        file: await assembleZip(entries, signal),
        filename: `${deployment.manifest.publicSlug}.zip`,
      };
    }

    const filename =
      artifact.filename ?? `${deployment.manifest.publicSlug}.html`;
    const manifestFile = deployment.manifest.files[deployment.entrypoint];
    return {
      contentType:
        artifact.contentType ??
        manifestFile?.contentType ??
        inferMimetype(filename),
      file: await get(
        downloadHostedSitesS3Buffer(
          bucket,
          hostedSiteFileKey(deployment.r2Prefix, deployment.entrypoint),
        ),
      ),
      filename,
    };
  });
}

function resolveS3ArtifactContent(
  artifact: ArtifactFileRow,
  s3Object: ArtifactS3Object,
): Computed<Promise<ResolvedArtifactContent>> {
  return computed(async (get): Promise<ResolvedArtifactContent> => {
    const filename = artifact.filename ?? artifact.externalId;
    const contentType = artifact.contentType ?? inferMimetype(filename);
    return {
      contentType,
      file: await get(downloadS3Buffer(s3Object.bucketName, s3Object.key)),
      filename,
    };
  });
}

type DriveTokenResult<T> =
  | { readonly type: "ok"; readonly value: T }
  | { readonly type: "unauthorized" };

async function findDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema> | null>> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}'`,
      `name = '${escapeQuery(args.name)}'`,
      "trashed = false",
      args.parentFolderId
        ? `'${escapeQuery(args.parentFolderId)}' in parents`
        : "'root' in parents",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${args.accessToken}` },
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive folder lookup failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveFolderListSchema.parse(await response.json());
  return { type: "ok", value: parsed.files[0] ?? null };
}

async function createDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema>>> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set("fields", "id,name");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: args.name,
      mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
      ...(args.parentFolderId ? { parents: [args.parentFolderId] } : {}),
    }),
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive folder creation failed with HTTP ${String(response.status)}`,
    );
  }
  return {
    type: "ok",
    value: driveFolderSchema.parse(await response.json()),
  };
}

async function ensureDriveFolder(args: {
  readonly accessToken: string;
  readonly parentFolderId: string | null;
  readonly name: string;
}): Promise<DriveTokenResult<z.infer<typeof driveFolderSchema>>> {
  const existing = await findDriveFolder(args);
  if (existing.type === "unauthorized") {
    return existing;
  }
  if (existing.value) {
    return { type: "ok", value: existing.value };
  }
  return await createDriveFolder(args);
}

async function ensureArtifactFolder(args: {
  readonly accessToken: string;
  readonly threadId: string;
}): Promise<DriveTokenResult<string>> {
  let parentFolderId: string | null = null;
  for (const name of ["vm0-artifact", `chat-${args.threadId}`]) {
    const folder = await ensureDriveFolder({
      accessToken: args.accessToken,
      parentFolderId,
      name,
    });
    if (folder.type === "unauthorized") {
      return folder;
    }
    parentFolderId = folder.value.id;
  }
  if (!parentFolderId) {
    throw badRequestMessage(
      "Google Drive artifact folder could not be resolved",
    );
  }
  return { type: "ok", value: parentFolderId };
}

async function uploadDriveFile(args: {
  readonly accessToken: string;
  readonly parentFolderId: string;
  readonly filename: string;
  readonly threadId: string;
  readonly runId: string;
  readonly fileId: string;
  readonly contentType: string;
  readonly file: Buffer;
}): Promise<Response> {
  const boundary = `vm0-${randomUUID()}`;
  const metadata = JSON.stringify({
    name: args.filename,
    mimeType: args.contentType,
    parents: [args.parentFolderId],
    appProperties: {
      [GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY]: "true",
      [GOOGLE_DRIVE_THREAD_APP_PROPERTY]: args.threadId,
      [GOOGLE_DRIVE_RUN_APP_PROPERTY]: args.runId,
      [GOOGLE_DRIVE_FILE_APP_PROPERTY]: args.fileId,
    },
  });
  const body = Buffer.concat([
    Buffer.from(
      [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        metadata,
        `--${boundary}`,
        `Content-Type: ${args.contentType}`,
        "",
        "",
      ].join("\r\n"),
      "utf8",
    ),
    args.file,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const uploadUrl = new URL(GOOGLE_DRIVE_UPLOAD_URL);
  uploadUrl.searchParams.set("uploadType", "multipart");
  uploadUrl.searchParams.set("fields", "id,name,webViewLink");

  return await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
}

async function uploadArtifactWithToken(args: {
  readonly accessToken: string;
  readonly threadId: string;
  readonly runId: string;
  readonly fileId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly file: Buffer;
}): Promise<DriveTokenResult<Response>> {
  const folder = await ensureArtifactFolder({
    accessToken: args.accessToken,
    threadId: args.threadId,
  });
  if (folder.type === "unauthorized") {
    return folder;
  }
  const response = await uploadDriveFile({
    accessToken: args.accessToken,
    parentFolderId: folder.value,
    filename: args.filename,
    threadId: args.threadId,
    runId: args.runId,
    fileId: args.fileId,
    contentType: args.contentType,
    file: args.file,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  return { type: "ok", value: response };
}

async function parseUploadResponse(
  response: Response,
): Promise<DriveSyncResult> {
  if (!response.ok) {
    throw badRequestMessage(
      `Google Drive upload failed with HTTP ${String(response.status)}`,
    );
  }
  const parsed = driveUploadResponseSchema.parse(await response.json());
  return {
    id: parsed.id,
    name: parsed.name,
    webViewLink: parsed.webViewLink ?? null,
  };
}

type NotFoundResponse = ReturnType<typeof notFound>;
type BadRequestResponse = ReturnType<typeof badRequestMessage>;

/**
 * Sync a chat-thread artifact file to the caller's connected Google Drive.
 *
 * Error mapping (preserves legacy web behavior where applicable):
 *  - 404 "Artifact file not found" — thread missing/cross-user, or no row.
 *  - 400 "Connect Google Drive before syncing artifacts" — connector
 *    absent, `needsReconnect`, or not authorized for the thread's agent.
 *  - 400 "This artifact file cannot be synced to Google Drive" — file
 *    location is missing or doesn't match a caller-owned artifact prefix.
 *  - 400 "Google Drive upload failed with HTTP <status>" — upload error
 *    after refresh-token retry exhausted.
 *  - 200 with `{ id, name, webViewLink }`.
 */
export const syncArtifactToGoogleDrive$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly runId: string;
      readonly fileId: string;
    },
    signal: AbortSignal,
  ): Promise<
    | NotFoundResponse
    | BadRequestResponse
    | { readonly status: 200; readonly body: DriveSyncResult }
  > => {
    const db = get(db$);

    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const tokens = await loadDriveTokens(
      db,
      args.orgId,
      args.userId,
      featureSwitchContext,
      snapshot,
    );
    signal.throwIfAborted();
    if (!tokens || tokens.needsReconnect) {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }

    const artifact = await loadArtifactFile(db, {
      threadId: args.threadId,
      runId: args.runId,
      fileId: args.fileId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact file not found");
    }

    const authorized = await threadAllowsGoogleDriveArtifactSync(db, {
      orgId: args.orgId,
      userId: args.userId,
      threadId: args.threadId,
    });
    signal.throwIfAborted();
    if (!authorized) {
      return badRequestMessage("Connect Google Drive before syncing artifacts");
    }

    const hostedContent = await get(
      resolveHostedArtifactContent(db, artifact, args.userId, signal),
    );
    signal.throwIfAborted();
    const s3Object = hostedContent
      ? null
      : await get(resolveArtifactS3Object(artifact, args.userId));
    signal.throwIfAborted();
    let content: ResolvedArtifactContent;
    if (hostedContent) {
      content = hostedContent;
    } else if (s3Object) {
      content = await get(resolveS3ArtifactContent(artifact, s3Object));
      signal.throwIfAborted();
    } else {
      return badRequestMessage(
        "This artifact file cannot be synced to Google Drive",
      );
    }

    let result = await uploadArtifactWithToken({
      accessToken: tokens.accessToken,
      threadId: args.threadId,
      runId: args.runId,
      fileId: args.fileId,
      filename: content.filename,
      contentType: content.contentType,
      file: content.file,
    });
    signal.throwIfAborted();

    if (result.type === "unauthorized") {
      const refreshed = await refreshDriveAccessToken({
        connection: tokens.connection,
        db,
        featureSwitchContext,
        orgId: args.orgId,
        signal,
        userId: args.userId,
      });
      signal.throwIfAborted();
      if (refreshed) {
        result = await uploadArtifactWithToken({
          accessToken: refreshed,
          threadId: args.threadId,
          runId: args.runId,
          fileId: args.fileId,
          filename: content.filename,
          contentType: content.contentType,
          file: content.file,
        });
        signal.throwIfAborted();
      }
    }

    if (result.type === "unauthorized") {
      return badRequestMessage("Google Drive upload failed with HTTP 401");
    }

    return {
      status: 200 as const,
      body: await parseUploadResponse(result.value),
    };
  },
);

// =====================================================================
// Upload-side: convert a presentation PPTX to a native Google Slides deck.
// =====================================================================

const GOOGLE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const PPTX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_GOOGLE_SLIDES_PPTX_BYTES = 100 * 1024 * 1024;

interface PresentationPptxSource {
  readonly uploadId: string;
}

interface ResolvedPresentationPptx {
  readonly filename: string;
  readonly pptx: Buffer;
}

function slidesTitle(filename: string): string {
  const trimmed = filename.trim();
  const base = trimmed.replace(/\.pptx$/i, "").trim();
  return base.length > 0 ? base : "presentation";
}

function resolvePresentationPptx(
  userId: string,
  source: PresentationPptxSource,
): Computed<
  Promise<ResolvedPresentationPptx | BadRequestResponse | NotFoundResponse>
> {
  return computed(async (get) => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const objects = await get(
      listS3Objects(bucket, buildArtifactPrefix(userId, source.uploadId)),
    );
    const object = objects[0];
    if (!object) {
      return notFound("Presentation upload not found");
    }

    const filename = object.key.split("/").pop() ?? source.uploadId;
    if (!filename.toLowerCase().endsWith(".pptx")) {
      return badRequestMessage("Presentation upload must be a PPTX file");
    }
    if (object.size > MAX_GOOGLE_SLIDES_PPTX_BYTES) {
      return badRequestMessage("Presentation file is too large (max 100 MB)");
    }

    const pptx = await get(
      downloadS3BufferWithMaxBytes(
        bucket,
        object.key,
        MAX_GOOGLE_SLIDES_PPTX_BYTES,
      ),
    );
    await get(deleteS3Objects(bucket, [object.key]));
    return { filename, pptx };
  });
}

async function startGoogleSlidesUpload(args: {
  readonly accessToken: string;
  readonly parentFolderId: string;
  readonly filename: string;
  readonly size: number;
}): Promise<DriveTokenResult<string>> {
  const metadata = JSON.stringify({
    name: slidesTitle(args.filename),
    mimeType: GOOGLE_SLIDES_MIME_TYPE,
    parents: [args.parentFolderId],
  });

  const uploadUrl = new URL(GOOGLE_DRIVE_UPLOAD_URL);
  uploadUrl.searchParams.set("uploadType", "resumable");
  uploadUrl.searchParams.set("fields", "id,name,webViewLink");

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(args.size),
      "X-Upload-Content-Type": PPTX_MIME_TYPE,
    },
    body: metadata,
  });
  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequestMessage(
      `Google Slides upload failed with HTTP ${String(response.status)}`,
    );
  }
  const sessionUrl = response.headers.get("location");
  if (!sessionUrl) {
    throw badRequestMessage("Google Slides upload session was not created");
  }
  return { type: "ok", value: sessionUrl };
}

/**
 * Upload PPTX bytes through a Drive resumable session and let Drive convert
 * them into a native Google Slides deck. Unlike the raw-artifact sync, no
 * `appProperties` are attached so the Slides file does not appear as a
 * "synced" raw artifact in the Drive status lookup.
 */
async function uploadPptxAsGoogleSlides(args: {
  readonly accessToken: string;
  readonly parentFolderId: string;
  readonly filename: string;
  readonly pptx: Buffer;
}): Promise<DriveTokenResult<Response>> {
  const session = await startGoogleSlidesUpload({
    accessToken: args.accessToken,
    parentFolderId: args.parentFolderId,
    filename: args.filename,
    size: args.pptx.length,
  });
  if (session.type === "unauthorized") {
    return session;
  }

  const response = await fetch(session.value, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": PPTX_MIME_TYPE,
      "Content-Length": String(args.pptx.length),
    },
    body: Uint8Array.from(args.pptx),
  });
  return response.status === 401
    ? { type: "unauthorized" }
    : { type: "ok", value: response };
}

async function uploadSlidesWithToken(args: {
  readonly accessToken: string;
  readonly threadId: string;
  readonly filename: string;
  readonly pptx: Buffer;
}): Promise<DriveTokenResult<Response>> {
  const folder = await ensureArtifactFolder({
    accessToken: args.accessToken,
    threadId: args.threadId,
  });
  if (folder.type === "unauthorized") {
    return folder;
  }
  return await uploadPptxAsGoogleSlides({
    accessToken: args.accessToken,
    parentFolderId: folder.value,
    filename: args.filename,
    pptx: args.pptx,
  });
}

/**
 * Upload a presentation's PPTX bytes to the caller's Google Drive as a native
 * Google Slides deck.
 *
 * Error mapping mirrors {@link syncArtifactToGoogleDrive$}:
 *  - 400 "Connect Google Drive before uploading to Google Slides" — connector
 *    absent or `needsReconnect`.
 *  - 400 for invalid or oversized staged presentation files.
 *  - 404 "Presentation upload not found" — staged upload absent or cross-user.
 *  - 400 "Google Slides upload failed with HTTP <status>" — upload error after
 *    refresh-token retry exhausted.
 *  - 200 with `{ id, name, webViewLink }`.
 */
export const uploadPresentationToGoogleSlides$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly threadId: string;
      readonly source: PresentationPptxSource;
    },
    signal: AbortSignal,
  ): Promise<
    | BadRequestResponse
    | NotFoundResponse
    | { readonly status: 200; readonly body: DriveSyncResult }
  > => {
    const db = get(db$);

    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const featureSwitchContext = {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    };
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const tokens = await loadDriveTokens(
      db,
      args.orgId,
      args.userId,
      featureSwitchContext,
      snapshot,
    );
    signal.throwIfAborted();
    if (!tokens || tokens.needsReconnect) {
      return badRequestMessage(
        "Connect Google Drive before uploading to Google Slides",
      );
    }

    const presentation = await get(
      resolvePresentationPptx(args.userId, args.source),
    );
    signal.throwIfAborted();
    if ("status" in presentation) {
      return presentation;
    }

    let result = await uploadSlidesWithToken({
      accessToken: tokens.accessToken,
      threadId: args.threadId,
      filename: presentation.filename,
      pptx: presentation.pptx,
    });
    signal.throwIfAborted();

    if (result.type === "unauthorized") {
      const refreshed = await refreshDriveAccessToken({
        connection: tokens.connection,
        db,
        featureSwitchContext,
        orgId: args.orgId,
        signal,
        userId: args.userId,
      });
      signal.throwIfAborted();
      if (refreshed) {
        result = await uploadSlidesWithToken({
          accessToken: refreshed,
          threadId: args.threadId,
          filename: presentation.filename,
          pptx: presentation.pptx,
        });
        signal.throwIfAborted();
      }
    }

    if (result.type === "unauthorized") {
      return badRequestMessage("Google Slides upload failed with HTTP 401");
    }

    return {
      status: 200 as const,
      body: await parseUploadResponse(result.value),
    };
  },
);
