import { randomUUID } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type {
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { connectors } from "@vm0/db/schema/connector";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { secrets } from "@vm0/db/schema/secret";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, notFound } from "../../lib/error";
import {
  buildArtifactKey,
  storageUserIdFromFileUrlSegment,
} from "../../lib/file-url";
import { db$, type ReadonlyDb } from "../external/db";
import { downloadS3Buffer, s3ObjectExists } from "../external/s3";
import { safeSync, settle } from "../utils";
import { decryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_STATUS_TIMEOUT_MS = 2000;
const GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY = "vm0Artifact";
const GOOGLE_DRIVE_THREAD_APP_PROPERTY = "vm0ThreadId";
const GOOGLE_DRIVE_RUN_APP_PROPERTY = "vm0RunId";
const GOOGLE_DRIVE_FILE_APP_PROPERTY = "vm0FileId";
const ACCESS_SECRET = "GOOGLE_DRIVE_ACCESS_TOKEN";
const REFRESH_SECRET = "GOOGLE_DRIVE_REFRESH_TOKEN";
const SECRET_TYPE = "connector";

const driveFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});
const driveFileListSchema = z.object({ files: z.array(driveFileSchema) });
const refreshResponseSchema = z.object({
  access_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
});

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
  readonly refreshToken: string | null;
  readonly needsReconnect: boolean;
}

function artifactKey(runId: string, fileId: string): string {
  return `${runId}:${fileId}`;
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, String.raw`\\`).replace(/'/g, String.raw`\'`);
}

async function loadDriveTokens(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
  featureSwitchContext: FeatureSwitchContext,
): Promise<ConnectorTokens | null> {
  const [connector] = await db
    .select({ needsReconnect: connectors.needsReconnect })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, orgId),
        eq(connectors.userId, userId),
        eq(connectors.type, "google-drive"),
      ),
    )
    .limit(1);
  if (!connector) {
    return null;
  }

  const secretRows = await db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.type, SECRET_TYPE),
      ),
    );

  let accessEncrypted: string | undefined;
  let refreshEncrypted: string | undefined;
  for (const row of secretRows) {
    if (row.name === ACCESS_SECRET) {
      accessEncrypted = row.encryptedValue;
    }
    if (row.name === REFRESH_SECRET) {
      refreshEncrypted = row.encryptedValue;
    }
  }
  if (!accessEncrypted) {
    return null;
  }

  return {
    accessToken: await decryptStoredSecretValue(
      accessEncrypted,
      featureSwitchContext,
    ),
    refreshToken: refreshEncrypted
      ? await decryptStoredSecretValue(refreshEncrypted, featureSwitchContext)
      : null,
    needsReconnect: connector.needsReconnect,
  };
}

async function refreshDriveAccessToken(
  refreshToken: string,
): Promise<string | null> {
  const clientId = optionalEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  const response = await fetch(GOOGLE_DRIVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    return null;
  }
  const parsed = refreshResponseSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data.access_token) {
    return null;
  }
  return parsed.data.access_token;
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
  readonly tokens: ConnectorTokens;
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<z.infer<typeof driveFileSchema>[] | "unauthorized"> {
  const first = await listArtifactFiles({
    accessToken: args.tokens.accessToken,
    threadId: args.threadId,
    signal: args.signal,
  });
  if (first.type === "ok") {
    return first.files;
  }
  if (!args.tokens.refreshToken) {
    return "unauthorized";
  }
  const refreshedAccessToken = await refreshDriveAccessToken(
    args.tokens.refreshToken,
  );
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

function resolveSyncStatus(
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
          googleDriveSync: resolveSyncStatus(lookup, run.runId, file.id),
        };
      }),
    };
  });
}

/**
 * Compute the Drive sync status lookup for a chat thread's artifacts.
 *
 * Scoped to Google Drive only (no generic provider registry) since this is the
 * sole API consumer of OAuth refresh today.
 *
 * Token persistence is intentionally deferred. When the in-flight access
 * token is rejected and the refresh succeeds, the new token is used for
 * the retry but is NOT written back to `secrets`; the next request will
 * refresh again. Keeps the route handler a read-only `computed`. Drive
 * status check is a UI poll, not a hot path; refresh tokens don't rotate
 * (Google), so the cost is one extra RTT per stale-token request.
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
    const featureSwitchOverrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    const tokens = await loadDriveTokens(db, args.orgId, args.userId, {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    });
    if (!tokens || tokens.needsReconnect) {
      return { type: "disconnected" };
    }
    // Schema-parse failure or transient network error — treat as "unknown"
    // rather than failing the whole artifacts response. AbortError from the
    // 2s timeout intentionally propagates under the project-wide ban on
    // swallowing aborts.
    const settled = await settle(
      listArtifactFilesWithRefresh({
        tokens,
        threadId: args.threadId,
        signal: AbortSignal.timeout(GOOGLE_DRIVE_STATUS_TIMEOUT_MS),
      }),
    );
    if (!settled.ok) {
      return { type: "unknown" };
    }
    if (settled.value === "unauthorized") {
      return { type: "unknown" };
    }
    return { type: "ready", syncedByKey: buildStatusMap(settled.value) };
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
        eq(runUploadedFiles.externalId, args.fileId),
        or(
          eq(zeroRuns.chatThreadId, args.threadId),
          sql`EXISTS (
            SELECT 1
            FROM ${chatMessages}
            WHERE ${chatMessages.runId} = ${runUploadedFiles.runId}
              AND ${chatMessages.chatThreadId} = ${args.threadId}
          )`,
        ),
      ),
    )
    .limit(1);
  return row ?? null;
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

interface LegacyFileUrlParts {
  readonly storageUserId: string;
  readonly id: string;
  readonly filename: string;
}

function decodeUrlSegment(segment: string): string | null {
  const result = safeSync(() => {
    return decodeURIComponent(segment);
  });
  if ("error" in result) {
    return null;
  }
  return result.ok;
}

function legacyFileUrlParts(value: string): LegacyFileUrlParts | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const segments = new URL(value).pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[0] !== "f") {
    return null;
  }

  const [, rawUserIdSegment, rawId, rawFilename] = segments;
  if (!rawUserIdSegment || !rawId || !rawFilename) {
    return null;
  }

  const userIdSegment = decodeUrlSegment(rawUserIdSegment);
  const id = decodeUrlSegment(rawId);
  const filename = decodeUrlSegment(rawFilename);
  if (!userIdSegment || !id || !filename) {
    return null;
  }

  return {
    storageUserId: storageUserIdFromFileUrlSegment(userIdSegment),
    id,
    filename,
  };
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
): Computed<Promise<ArtifactS3Object | null>> {
  return computed(async (get): Promise<ArtifactS3Object | null> => {
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

    for (const sourceUrl of artifactSourceUrls(artifact)) {
      const legacy = legacyFileUrlParts(sourceUrl);
      if (!legacy || legacy.storageUserId !== userId) {
        continue;
      }

      const artifactBucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
      const artifactKey = buildArtifactKey(
        legacy.storageUserId,
        legacy.id,
        legacy.filename,
      );
      if (await get(s3ObjectExists(artifactBucket, artifactKey))) {
        return { bucketName: artifactBucket, key: artifactKey };
      }

      return {
        bucketName: env("R2_USER_STORAGES_BUCKET_NAME"),
        key: `uploads/${legacy.storageUserId}/${legacy.id}/${legacy.filename}`,
      };
    }

    return null;
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
 *    absent or `needsReconnect`.
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
    const tokens = await loadDriveTokens(db, args.orgId, args.userId, {
      orgId: args.orgId,
      userId: args.userId,
      overrides: featureSwitchOverrides,
    });
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

    const s3Object = await get(resolveArtifactS3Object(artifact, args.userId));
    signal.throwIfAborted();
    if (!s3Object) {
      return badRequestMessage(
        "This artifact file cannot be synced to Google Drive",
      );
    }

    const filename = artifact.filename ?? artifact.externalId;
    const contentType = artifact.contentType ?? inferMimetype(filename);
    const file = await get(downloadS3Buffer(s3Object.bucketName, s3Object.key));
    signal.throwIfAborted();

    let result = await uploadArtifactWithToken({
      accessToken: tokens.accessToken,
      threadId: args.threadId,
      runId: args.runId,
      fileId: args.fileId,
      filename,
      contentType,
      file,
    });
    signal.throwIfAborted();

    if (result.type === "unauthorized" && tokens.refreshToken) {
      const refreshed = await refreshDriveAccessToken(tokens.refreshToken);
      signal.throwIfAborted();
      if (refreshed) {
        result = await uploadArtifactWithToken({
          accessToken: refreshed,
          threadId: args.threadId,
          runId: args.runId,
          fileId: args.fileId,
          filename,
          contentType,
          file,
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
