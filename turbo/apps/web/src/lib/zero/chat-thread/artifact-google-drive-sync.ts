import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "@vm0/api-services/errors";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import type {
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import { env } from "../../../env";
import { downloadS3Buffer } from "../../infra/s3/s3-client";
import { inferMimetype } from "../../shared/mimetype";
import { logger } from "../../shared/logger";
import {
  getConnector,
  getConnectorAccessToken,
  getConnectorRefreshToken,
  refreshConnectorAccessToken,
} from "../connector/connector-service";
import { getChatThread } from "./chat-thread-service";

const GOOGLE_DRIVE_UPLOAD_URL =
  "https://www.googleapis.com/upload/drive/v3/files";
const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY = "vm0Artifact";
const GOOGLE_DRIVE_THREAD_APP_PROPERTY = "vm0ThreadId";
const GOOGLE_DRIVE_RUN_APP_PROPERTY = "vm0RunId";
const GOOGLE_DRIVE_FILE_APP_PROPERTY = "vm0FileId";
const GOOGLE_DRIVE_STATUS_TIMEOUT_MS = 2_000;

const log = logger("service:artifact-google-drive-sync");

const googleDriveUploadResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
});

const googleDriveFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const googleDriveFolderListSchema = z.object({
  files: z.array(googleDriveFolderSchema),
});

const googleDriveArtifactFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  webViewLink: z.string().nullable().optional(),
  appProperties: z.record(z.string(), z.string()).optional(),
});

const googleDriveArtifactFileListSchema = z.object({
  files: z.array(googleDriveArtifactFileSchema),
});

type GoogleDriveTokenResult<T> =
  | { type: "ok"; value: T }
  | { type: "unauthorized" };

type ArtifactFileRow = {
  runId: string;
  source: string;
  externalId: string;
  filename: string | null;
  contentType: string | null;
  url: string | null;
  metadata: Record<string, unknown>;
};

type GoogleDriveSyncResult = {
  id: string;
  name: string;
  webViewLink: string | null;
};

type GoogleDriveArtifactStatusLookup =
  | { type: "ready"; syncedByKey: Map<string, GoogleDriveSyncResult> }
  | { type: "disconnected" }
  | { type: "unknown" };

function googleDriveArtifactKey(params: {
  runId: string;
  fileId: string;
}): string {
  return `${params.runId}:${params.fileId}`;
}

export function applyGoogleDriveArtifactSyncStatuses(
  runs: ChatThreadArtifactRun[],
  lookup: GoogleDriveArtifactStatusLookup,
): ChatThreadArtifactRun[] {
  return runs.map((run) => {
    return {
      ...run,
      files: run.files.map((file) => {
        return {
          ...file,
          googleDriveSync: resolveGoogleDriveSyncStatus({
            lookup,
            runId: run.runId,
            fileId: file.id,
          }),
        };
      }),
    };
  });
}

function resolveGoogleDriveSyncStatus(params: {
  lookup: GoogleDriveArtifactStatusLookup;
  runId: string;
  fileId: string;
}): ChatThreadArtifactGoogleDriveSync {
  if (params.lookup.type === "disconnected") {
    return { status: "disconnected" };
  }
  if (params.lookup.type === "unknown") {
    return { status: "unknown" };
  }

  const synced = params.lookup.syncedByKey.get(
    googleDriveArtifactKey({
      runId: params.runId,
      fileId: params.fileId,
    }),
  );
  return synced ? { status: "synced", ...synced } : { status: "not_synced" };
}

export async function getGoogleDriveArtifactStatusLookup(params: {
  threadId: string;
  orgId: string;
  userId: string;
}): Promise<GoogleDriveArtifactStatusLookup> {
  return await readGoogleDriveArtifactStatusLookup(params).then(
    (lookup) => {
      return lookup;
    },
    (error: unknown) => {
      log.warn("failed to read Google Drive artifact sync status", error);
      return { type: "unknown" as const };
    },
  );
}

async function readGoogleDriveArtifactStatusLookup(params: {
  threadId: string;
  orgId: string;
  userId: string;
}): Promise<GoogleDriveArtifactStatusLookup> {
  const connector = await getConnector(
    params.orgId,
    params.userId,
    "google-drive",
  );
  if (!connector || connector.needsReconnect) {
    return { type: "disconnected" };
  }

  const accessToken = await getConnectorAccessToken(
    "google-drive",
    params.orgId,
    params.userId,
  );
  if (!accessToken) {
    return { type: "disconnected" };
  }

  const files = await listGoogleDriveArtifactFilesWithRefresh({
    accessToken,
    threadId: params.threadId,
    orgId: params.orgId,
    userId: params.userId,
    signal: AbortSignal.timeout(GOOGLE_DRIVE_STATUS_TIMEOUT_MS),
  });
  if (files.type === "unauthorized") {
    return { type: "unknown" };
  }

  return {
    type: "ready",
    syncedByKey: googleDriveArtifactsToStatusMap(files.value),
  };
}

export async function syncArtifactToGoogleDrive(params: {
  threadId: string;
  runId: string;
  fileId: string;
  orgId: string;
  userId: string;
}): Promise<GoogleDriveSyncResult> {
  const connector = await getConnector(
    params.orgId,
    params.userId,
    "google-drive",
  );
  if (!connector || connector.needsReconnect) {
    throw badRequest("Connect Google Drive before syncing artifacts");
  }

  const accessToken = await getConnectorAccessToken(
    "google-drive",
    params.orgId,
    params.userId,
  );
  if (!accessToken) {
    throw badRequest("Connect Google Drive before syncing artifacts");
  }

  const artifact = await getThreadArtifactFile(params);
  const s3Key = resolveArtifactS3Key(artifact, params.userId);
  if (!s3Key) {
    throw badRequest("This artifact file cannot be synced to Google Drive");
  }

  const filename = artifact.filename ?? artifact.externalId;
  const contentType = artifact.contentType ?? inferMimetype(filename);
  const file = await downloadS3Buffer(
    env().R2_USER_STORAGES_BUCKET_NAME,
    s3Key,
  );

  let result = await uploadArtifactWithGoogleDriveToken({
    accessToken,
    threadId: params.threadId,
    runId: params.runId,
    fileId: params.fileId,
    filename,
    contentType,
    file,
  });

  if (result.type === "unauthorized") {
    const refreshedToken = await refreshGoogleDriveAccessToken(
      params.orgId,
      params.userId,
    );
    if (refreshedToken) {
      result = await uploadArtifactWithGoogleDriveToken({
        accessToken: refreshedToken,
        threadId: params.threadId,
        runId: params.runId,
        fileId: params.fileId,
        filename,
        contentType,
        file,
      });
    }
  }

  if (result.type === "unauthorized") {
    throw badRequest("Google Drive upload failed with HTTP 401");
  }

  return await parseGoogleDriveUploadResponse(result.value);
}

async function getThreadArtifactFile(params: {
  threadId: string;
  runId: string;
  fileId: string;
  userId: string;
}): Promise<ArtifactFileRow> {
  await getChatThread(params.threadId, params.userId);

  const [row] = await globalThis.services.db
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
        eq(runUploadedFiles.userId, params.userId),
        eq(runUploadedFiles.runId, params.runId),
        eq(runUploadedFiles.externalId, params.fileId),
        or(
          eq(zeroRuns.chatThreadId, params.threadId),
          sql`EXISTS (
            SELECT 1
            FROM ${chatMessages}
            WHERE ${chatMessages.runId} = ${runUploadedFiles.runId}
              AND ${chatMessages.chatThreadId} = ${params.threadId}
          )`,
        ),
      ),
    )
    .limit(1);

  if (!row) {
    throw notFound("Artifact file not found");
  }

  return row;
}

function resolveArtifactS3Key(
  artifact: ArtifactFileRow,
  userId: string,
): string | null {
  const metadataS3Key = artifact.metadata.s3Key;
  if (
    typeof metadataS3Key === "string" &&
    metadataS3Key.startsWith(`uploads/${userId}/`)
  ) {
    return metadataS3Key;
  }

  const urlS3Key = artifact.url
    ? parseFileUrlS3Key(artifact.url, userId)
    : null;
  if (urlS3Key) {
    return urlS3Key;
  }

  if (artifact.source === "web" && artifact.filename) {
    return `uploads/${userId}/${artifact.externalId}/${artifact.filename}`;
  }

  return null;
}

function parseFileUrlS3Key(url: string, userId: string): string | null {
  if (!URL.canParse(url)) {
    return null;
  }

  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[0] !== "f") {
    return null;
  }

  const urlUserId = decodeURIComponent(segments[1]!);
  if (urlUserId !== userId) {
    return null;
  }

  const fileId = segments[2]!;
  const filename = decodeURIComponent(segments.slice(3).join("/"));
  return `uploads/${urlUserId}/${fileId}/${filename}`;
}

async function refreshGoogleDriveAccessToken(
  orgId: string,
  userId: string,
): Promise<string | null> {
  const refreshToken = await getConnectorRefreshToken(
    "google-drive",
    orgId,
    userId,
  );
  if (!refreshToken) {
    return null;
  }

  return await refreshConnectorAccessToken("google-drive", orgId, userId, {
    [refreshToken.secretName]: refreshToken.token,
  });
}

async function uploadArtifactWithGoogleDriveToken(params: {
  accessToken: string;
  threadId: string;
  runId: string;
  fileId: string;
  filename: string;
  contentType: string;
  file: Buffer;
}): Promise<GoogleDriveTokenResult<Response>> {
  const folderId = await ensureGoogleDriveArtifactFolder({
    accessToken: params.accessToken,
    threadId: params.threadId,
  });
  if (folderId.type === "unauthorized") {
    return folderId;
  }

  const response = await uploadGoogleDriveFile({
    accessToken: params.accessToken,
    parentFolderId: folderId.value,
    filename: params.filename,
    threadId: params.threadId,
    runId: params.runId,
    fileId: params.fileId,
    contentType: params.contentType,
    file: params.file,
  });

  if (response.status === 401) {
    return { type: "unauthorized" };
  }

  return { type: "ok", value: response };
}

async function ensureGoogleDriveArtifactFolder(params: {
  accessToken: string;
  threadId: string;
}): Promise<GoogleDriveTokenResult<string>> {
  let parentFolderId: string | null = null;
  for (const name of ["vm0-artifact", `chat-${params.threadId}`]) {
    const folder = await ensureGoogleDriveFolder({
      accessToken: params.accessToken,
      parentFolderId,
      name,
    });
    if (folder.type === "unauthorized") {
      return folder;
    }
    parentFolderId = folder.value.id;
  }

  if (!parentFolderId) {
    throw badRequest("Google Drive artifact folder could not be resolved");
  }

  return { type: "ok", value: parentFolderId };
}

async function ensureGoogleDriveFolder(params: {
  accessToken: string;
  parentFolderId: string | null;
  name: string;
}): Promise<GoogleDriveTokenResult<z.infer<typeof googleDriveFolderSchema>>> {
  const existingFolder = await findGoogleDriveFolder(params);
  if (existingFolder.type === "unauthorized") {
    return existingFolder;
  }
  if (existingFolder.value) {
    return { type: "ok", value: existingFolder.value };
  }

  return await createGoogleDriveFolder(params);
}

async function findGoogleDriveFolder(params: {
  accessToken: string;
  parentFolderId: string | null;
  name: string;
}): Promise<
  GoogleDriveTokenResult<z.infer<typeof googleDriveFolderSchema> | null>
> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `mimeType = '${GOOGLE_DRIVE_FOLDER_MIME_TYPE}'`,
      `name = '${escapeGoogleDriveQueryString(params.name)}'`,
      "trashed = false",
      params.parentFolderId
        ? `'${escapeGoogleDriveQueryString(params.parentFolderId)}' in parents`
        : "'root' in parents",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
  });

  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequest(
      `Google Drive folder lookup failed with HTTP ${response.status}`,
    );
  }

  const parsed = googleDriveFolderListSchema.parse(await response.json());
  return { type: "ok", value: parsed.files[0] ?? null };
}

async function createGoogleDriveFolder(params: {
  accessToken: string;
  parentFolderId: string | null;
  name: string;
}): Promise<GoogleDriveTokenResult<z.infer<typeof googleDriveFolderSchema>>> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set("fields", "id,name");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: params.name,
      mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
      ...(params.parentFolderId ? { parents: [params.parentFolderId] } : {}),
    }),
  });

  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequest(
      `Google Drive folder creation failed with HTTP ${response.status}`,
    );
  }

  return {
    type: "ok",
    value: googleDriveFolderSchema.parse(await response.json()),
  };
}

function escapeGoogleDriveQueryString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listGoogleDriveArtifactFilesWithRefresh(params: {
  accessToken: string;
  threadId: string;
  orgId: string;
  userId: string;
  signal?: AbortSignal;
}): Promise<
  GoogleDriveTokenResult<z.infer<typeof googleDriveArtifactFileSchema>[]>
> {
  let result = await listGoogleDriveArtifactFiles(params);
  if (result.type !== "unauthorized") {
    return result;
  }

  const refreshedToken = await refreshGoogleDriveAccessToken(
    params.orgId,
    params.userId,
  );
  if (!refreshedToken) {
    return result;
  }

  result = await listGoogleDriveArtifactFiles({
    accessToken: refreshedToken,
    threadId: params.threadId,
    signal: params.signal,
  });
  return result;
}

async function listGoogleDriveArtifactFiles(params: {
  accessToken: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<
  GoogleDriveTokenResult<z.infer<typeof googleDriveArtifactFileSchema>[]>
> {
  const url = new URL(GOOGLE_DRIVE_FILES_URL);
  url.searchParams.set(
    "q",
    [
      `appProperties has { key='${GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY}' and value='true' }`,
      `appProperties has { key='${GOOGLE_DRIVE_THREAD_APP_PROPERTY}' and value='${escapeGoogleDriveQueryString(
        params.threadId,
      )}' }`,
      "trashed = false",
    ].join(" and "),
  );
  url.searchParams.set("fields", "files(id,name,webViewLink,appProperties)");
  url.searchParams.set("pageSize", "1000");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
    },
    signal: params.signal,
  });

  if (response.status === 401) {
    return { type: "unauthorized" };
  }
  if (!response.ok) {
    throw badRequest(
      `Google Drive artifact lookup failed with HTTP ${response.status}`,
    );
  }

  const parsed = googleDriveArtifactFileListSchema.parse(await response.json());
  return { type: "ok", value: parsed.files };
}

function googleDriveArtifactsToStatusMap(
  files: z.infer<typeof googleDriveArtifactFileSchema>[],
): Map<string, GoogleDriveSyncResult> {
  const map = new Map<string, GoogleDriveSyncResult>();
  for (const file of files) {
    const runId = file.appProperties?.[GOOGLE_DRIVE_RUN_APP_PROPERTY];
    const fileId = file.appProperties?.[GOOGLE_DRIVE_FILE_APP_PROPERTY];
    if (!runId || !fileId) {
      continue;
    }
    map.set(googleDriveArtifactKey({ runId, fileId }), {
      id: file.id,
      name: file.name,
      webViewLink: file.webViewLink ?? null,
    });
  }
  return map;
}

async function uploadGoogleDriveFile(params: {
  accessToken: string;
  parentFolderId: string;
  filename: string;
  threadId: string;
  runId: string;
  fileId: string;
  contentType: string;
  file: Buffer;
}): Promise<Response> {
  const boundary = `vm0-${randomUUID()}`;
  const metadata = JSON.stringify({
    name: params.filename,
    mimeType: params.contentType,
    parents: [params.parentFolderId],
    appProperties: {
      [GOOGLE_DRIVE_ARTIFACT_APP_PROPERTY]: "true",
      [GOOGLE_DRIVE_THREAD_APP_PROPERTY]: params.threadId,
      [GOOGLE_DRIVE_RUN_APP_PROPERTY]: params.runId,
      [GOOGLE_DRIVE_FILE_APP_PROPERTY]: params.fileId,
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
        `Content-Type: ${params.contentType}`,
        "",
        "",
      ].join("\r\n"),
      "utf8",
    ),
    params.file,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const uploadUrl = new URL(GOOGLE_DRIVE_UPLOAD_URL);
  uploadUrl.searchParams.set("uploadType", "multipart");
  uploadUrl.searchParams.set("fields", "id,name,webViewLink");

  return await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
  });
}

async function parseGoogleDriveUploadResponse(
  response: Response,
): Promise<GoogleDriveSyncResult> {
  if (!response.ok) {
    throw badRequest(readGoogleDriveError(response));
  }

  const parsed = googleDriveUploadResponseSchema.parse(await response.json());
  return {
    id: parsed.id,
    name: parsed.name,
    webViewLink: parsed.webViewLink ?? null,
  };
}

function readGoogleDriveError(response: Response): string {
  return `Google Drive upload failed with HTTP ${response.status}`;
}
