import { computed, type Computed } from "ccstate";
import type {
  ChatThreadArtifactGoogleDriveSync,
  ChatThreadArtifactRun,
} from "@vm0/api-contracts/contracts/chat-threads";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { db$, type ReadonlyDb } from "../external/db";
import { decryptSecretValue } from "./crypto.utils";

const GOOGLE_DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_DRIVE_TOKEN_URL = "https://oauth2.googleapis.com/token";
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
    accessToken: decryptSecretValue(accessEncrypted),
    refreshToken: refreshEncrypted
      ? decryptSecretValue(refreshEncrypted)
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
 * Mirrors `getGoogleDriveArtifactStatusLookup` in
 * `apps/web/src/lib/zero/chat-thread/artifact-google-drive-sync.ts` —
 * scoped to Google Drive only (no generic provider registry) since this
 * is the sole api consumer of OAuth refresh today.
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
    const tokens = await loadDriveTokens(db, args.orgId, args.userId);
    if (!tokens || tokens.needsReconnect) {
      return { type: "disconnected" };
    }
    return listArtifactFilesWithRefresh({
      tokens,
      threadId: args.threadId,
      signal: AbortSignal.timeout(GOOGLE_DRIVE_STATUS_TIMEOUT_MS),
    }).then(
      (result): DriveStatusLookup => {
        if (result === "unauthorized") {
          return { type: "unknown" };
        }
        return { type: "ready", syncedByKey: buildStatusMap(result) };
      },
      // Timeout, schema-parse failure, transient network error — treat as
      // "unknown" rather than failing the whole artifacts response. The 2s
      // timeout is the explicit abort source here, so AbortError is part
      // of the expected swallow set.
      (): DriveStatusLookup => {
        return { type: "unknown" };
      },
    );
  });
}
