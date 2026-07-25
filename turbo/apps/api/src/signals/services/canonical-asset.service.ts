import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  chatMessageAssetRefs,
  runUploadedFiles,
  type CanonicalAssetMaterializationStatus,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";
import { slackChatIngress } from "@vm0/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@vm0/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { SlackFile } from "../../lib/slack-webhook-context";
import { env } from "../../lib/env";
import {
  buildArtifactKey,
  buildFileUrl,
  sanitizeArtifactFilename,
} from "../../lib/file-url";
import { inferMimetype } from "../../lib/mimetype";
import { isAllowedUploadType } from "../../lib/uploads-constants";
import { type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import {
  fetchSlackFile,
  isSlackFileFetchError,
  MAX_SLACK_FILE_SIZE_BYTES,
  SlackFileFetchError,
} from "../external/slack-file-fetcher";
import {
  generatePresignedPutUrl,
  putS3Object,
  s3ObjectHead,
} from "../external/s3";
import { settleIncludingAbort } from "../utils";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { sourceForRun } from "./run-uploaded-files.service";

const CANONICAL_UPLOAD_URL_TTL_SECONDS = 3600;
const SLACK_INPUT_IMPORT_TIMEOUT_MS = 10_000;
const historicalSlackEventSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  event: z.object({
    ts: z.string(),
    channel: z.string(),
    files: z.array(z.custom<SlackFile>()).optional(),
  }),
});

export interface CanonicalSlackInputAsset {
  readonly assetId: string;
  readonly position: number;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly status: CanonicalAssetMaterializationStatus;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

interface CanonicalSlackInputFileArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly chatThreadId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly botToken?: string;
  readonly file: SlackFile;
  readonly position: number;
}

interface CanonicalAssetRow {
  readonly id: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly materializationStatus: CanonicalAssetMaterializationStatus | null;
  readonly materializationError: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly checksumSha256: string | null;
  readonly storageKey: string | null;
  readonly url: string | null;
}

function slackFileFilename(file: SlackFile): string {
  return file.name || file.title || file.id || "Untitled";
}

function slackFileContentType(file: SlackFile, filename: string): string {
  return (
    file.mimetype?.split(";")[0]?.trim().toLowerCase() ??
    inferMimetype(filename)
  );
}

function inputMaterializationError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  if (isSlackFileFetchError(error)) {
    const retryable =
      error.code === "download-failed" &&
      (error.statusCode === 429 || (error.statusCode ?? 0) >= 500);
    return { code: error.code, message: error.message, retryable };
  }
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "TimeoutError"
  ) {
    return {
      code: "timeout",
      message: "Slack file import timed out",
      retryable: true,
    };
  }
  return {
    code: "import-failed",
    message:
      error instanceof Error ? error.message : "Slack file import failed",
    retryable: true,
  };
}

async function readSlackFileBuffer(response: Response): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > MAX_SLACK_FILE_SIZE_BYTES) {
      await reader.cancel();
      throw new SlackFileFetchError("too-large", "File exceeds maximum size");
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, size);
}

function canonicalAssetSelection() {
  return {
    id: runUploadedFiles.id,
    filename: runUploadedFiles.filename,
    contentType: runUploadedFiles.contentType,
    sizeBytes: runUploadedFiles.sizeBytes,
    materializationStatus: runUploadedFiles.materializationStatus,
    materializationError: runUploadedFiles.materializationError,
    checksumSha256: runUploadedFiles.checksumSha256,
    storageKey: runUploadedFiles.storageKey,
    url: runUploadedFiles.url,
  } as const;
}

async function canonicalAssetByIdentity(
  db: Db,
  args: {
    readonly userId: string;
    readonly scope: string;
    readonly key: string;
  },
): Promise<CanonicalAssetRow | undefined> {
  const [asset] = await db
    .select(canonicalAssetSelection())
    .from(runUploadedFiles)
    .where(
      and(
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        eq(runUploadedFiles.idempotencyScope, args.scope),
        eq(runUploadedFiles.idempotencyKey, args.key),
      ),
    )
    .limit(1);
  return asset;
}

function canonicalInputAssetIdentityCondition(assetId: string, userId: string) {
  return and(
    eq(runUploadedFiles.id, assetId),
    eq(runUploadedFiles.userId, userId),
    eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    eq(runUploadedFiles.classification, "input"),
  );
}

function canonicalInputObservedStateCondition(asset: CanonicalAssetRow) {
  return asset.materializationStatus === null
    ? isNull(runUploadedFiles.materializationStatus)
    : eq(runUploadedFiles.materializationStatus, asset.materializationStatus);
}

function canonicalInputTransitionCondition(
  asset: CanonicalAssetRow,
  userId: string,
) {
  return and(
    canonicalInputAssetIdentityCondition(asset.id, userId),
    canonicalInputObservedStateCondition(asset),
    asset.materializationStatus === "ready" ? sql`false` : undefined,
  );
}

async function canonicalInputAssetById(
  db: Db,
  args: {
    readonly assetId: string;
    readonly userId: string;
  },
): Promise<CanonicalAssetRow | undefined> {
  const [asset] = await db
    .select(canonicalAssetSelection())
    .from(runUploadedFiles)
    .where(canonicalInputAssetIdentityCondition(args.assetId, args.userId))
    .limit(1);
  return asset;
}

async function canonicalInputAssetAfterTransitionConflict(
  db: Db,
  asset: CanonicalAssetRow,
  userId: string,
): Promise<CanonicalAssetRow> {
  const current = await canonicalInputAssetById(db, {
    assetId: asset.id,
    userId,
  });
  if (!current) {
    throw new Error("Canonical Slack input asset no longer exists");
  }
  return current;
}

async function ensureSlackInputAsset(
  db: Db,
  args: CanonicalSlackInputFileArgs & {
    readonly fileId: string;
    readonly filename: string;
    readonly contentType: string;
  },
): Promise<CanonicalAssetRow> {
  const assetId = randomUUID();
  const storageKey = buildArtifactKey(
    args.userId,
    assetId,
    sanitizeArtifactFilename(args.filename),
  );
  const scope = "slack-input";
  const [inserted] = await db
    .insert(runUploadedFiles)
    .values({
      id: assetId,
      runId: null,
      chatThreadId: args.chatThreadId,
      source: "slack",
      externalId: args.fileId,
      userId: args.userId,
      orgId: args.orgId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.file.size ?? null,
      url: null,
      metadata: {},
      assetVersion: CANONICAL_ASSET_VERSION,
      classification: "input",
      accessLevel: "private",
      materializationStatus: "pending",
      checksumSha256: null,
      storageKey,
      provenance: {
        provider: "slack",
        workspaceId: args.workspaceId,
        channelId: args.channelId,
        messageTs: args.messageTs,
        externalFileId: args.fileId,
      },
      materializationError: null,
      idempotencyScope: scope,
      idempotencyKey: args.fileId,
    })
    .onConflictDoNothing({
      target: [
        runUploadedFiles.userId,
        runUploadedFiles.idempotencyScope,
        runUploadedFiles.idempotencyKey,
      ],
      where: eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    })
    .returning(canonicalAssetSelection());
  if (inserted) {
    return inserted;
  }
  const existing = await canonicalAssetByIdentity(db, {
    userId: args.userId,
    scope,
    key: args.fileId,
  });
  if (!existing) {
    throw new Error("Canonical Slack input asset conflict is missing");
  }
  return existing;
}

function canonicalSlackInputResult(
  asset: CanonicalAssetRow,
  position: number,
): CanonicalSlackInputAsset {
  const status = asset.materializationStatus ?? "failed";
  return {
    assetId: asset.id,
    position,
    filename: asset.filename ?? asset.id,
    contentType: asset.contentType ?? inferMimetype(asset.filename ?? asset.id),
    size: asset.sizeBytes ?? 0,
    status,
    ...(status === "failed" && asset.materializationError
      ? { error: asset.materializationError }
      : {}),
  };
}

type CanonicalMaterializationError = NonNullable<
  CanonicalAssetRow["materializationError"]
>;

function immediateSlackInputError(
  file: SlackFile,
  contentType: string,
): CanonicalMaterializationError | undefined {
  if (file.size !== undefined && file.size > MAX_SLACK_FILE_SIZE_BYTES) {
    return {
      code: "too-large",
      message: "File exceeds maximum size",
      retryable: false,
    };
  }
  if (!isAllowedUploadType(contentType)) {
    return {
      code: "unsupported-type",
      message: `Unsupported file type: ${contentType}`,
      retryable: false,
    };
  }
  if (!file.url_private_download) {
    return {
      code: "missing-download-url",
      message: "Slack did not provide a private download URL",
      retryable: true,
    };
  }
  return undefined;
}

async function markCanonicalInputFailed(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
    readonly error: CanonicalMaterializationError;
  },
): Promise<CanonicalAssetRow> {
  if (args.asset.materializationStatus === "ready") {
    return args.asset;
  }
  const [failed] = await db
    .update(runUploadedFiles)
    .set({
      materializationStatus: "failed",
      materializationError: args.error,
      updatedAt: sql`now()`,
    })
    .where(canonicalInputTransitionCondition(args.asset, args.userId))
    .returning(canonicalAssetSelection());
  return (
    failed ??
    (await canonicalInputAssetAfterTransitionConflict(
      db,
      args.asset,
      args.userId,
    ))
  );
}

async function markCanonicalInputReady(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string;
  },
): Promise<CanonicalAssetRow> {
  let observed = args.asset;
  while (observed.materializationStatus !== "ready") {
    const [ready] = await db
      .update(runUploadedFiles)
      .set({
        sizeBytes: args.sizeBytes,
        checksumSha256: args.checksumSha256,
        materializationStatus: "ready",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(canonicalInputTransitionCondition(observed, args.userId))
      .returning(canonicalAssetSelection());
    if (ready) {
      return ready;
    }
    observed = await canonicalInputAssetAfterTransitionConflict(
      db,
      observed,
      args.userId,
    );
  }
  return observed;
}

async function resetCanonicalInputPending(
  db: Db,
  args: {
    readonly asset: CanonicalAssetRow;
    readonly userId: string;
  },
): Promise<CanonicalAssetRow> {
  let observed = args.asset;
  while (
    observed.materializationStatus !== "ready" &&
    observed.materializationStatus !== "pending" &&
    !(
      observed.materializationStatus === "failed" &&
      observed.materializationError?.retryable === false
    )
  ) {
    const [pending] = await db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "pending",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(canonicalInputTransitionCondition(observed, args.userId))
      .returning(canonicalAssetSelection());
    if (pending) {
      return pending;
    }
    observed = await canonicalInputAssetAfterTransitionConflict(
      db,
      observed,
      args.userId,
    );
  }
  return observed;
}

const importCanonicalSlackInputFile$ = command(
  async (
    { get, set },
    args: {
      readonly asset: CanonicalAssetRow;
      readonly userId: string;
      readonly position: number;
      readonly downloadUrl: string;
      readonly botToken: string;
      readonly contentType: string;
    },
    signal: AbortSignal,
  ): Promise<CanonicalSlackInputAsset> => {
    const importSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(SLACK_INPUT_IMPORT_TIMEOUT_MS),
    ]);
    const imported = await settleIncludingAbort(
      (async (): Promise<{
        readonly buffer: Buffer;
        readonly checksumSha256: string;
      }> => {
        const response = await fetchSlackFile(
          args.downloadUrl,
          args.botToken,
          importSignal,
        );
        const buffer = await readSlackFileBuffer(response);
        importSignal.throwIfAborted();
        if (buffer.length === 0) {
          throw new SlackFileFetchError(
            "download-failed",
            "Slack file is empty",
          );
        }
        const checksumSha256 = createHash("sha256")
          .update(buffer)
          .digest("hex");
        if (!args.asset.storageKey) {
          throw new Error("Canonical Slack input asset storage key is missing");
        }
        await get(
          putS3Object(
            env("R2_USER_ARTIFACTS_BUCKET_NAME"),
            args.asset.storageKey,
            buffer,
            args.contentType,
            importSignal,
          ),
        );
        return { buffer, checksumSha256 };
      })(),
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    if (!imported.ok) {
      const failed = await markCanonicalInputFailed(db, {
        asset: args.asset,
        userId: args.userId,
        error: inputMaterializationError(
          importSignal.aborted ? importSignal.reason : imported.error,
        ),
      });
      signal.throwIfAborted();
      return canonicalSlackInputResult(failed, args.position);
    }
    const ready = await markCanonicalInputReady(db, {
      asset: args.asset,
      userId: args.userId,
      sizeBytes: imported.value.buffer.length,
      checksumSha256: imported.value.checksumSha256,
    });
    signal.throwIfAborted();
    return canonicalSlackInputResult(ready, args.position);
  },
);

const materializeCanonicalSlackInputFile$ = command(
  async (
    { set },
    args: CanonicalSlackInputFileArgs,
    signal: AbortSignal,
  ): Promise<CanonicalSlackInputAsset | null> => {
    const fileId = args.file.id;
    if (!fileId) {
      return null;
    }
    const filename = slackFileFilename(args.file);
    const contentType = slackFileContentType(args.file, filename);
    const db = set(writeDb$);
    let asset = await ensureSlackInputAsset(db, {
      ...args,
      fileId,
      filename,
      contentType,
    });
    signal.throwIfAborted();
    if (asset.materializationStatus === "ready") {
      return canonicalSlackInputResult(asset, args.position);
    }
    if (
      asset.materializationStatus === "failed" &&
      asset.materializationError?.retryable === false
    ) {
      return canonicalSlackInputResult(asset, args.position);
    }

    const immediateError = immediateSlackInputError(args.file, contentType);
    if (immediateError) {
      asset = await markCanonicalInputFailed(db, {
        asset,
        userId: args.userId,
        error: immediateError,
      });
      return canonicalSlackInputResult(asset, args.position);
    }
    if (!args.botToken) {
      asset = await markCanonicalInputFailed(db, {
        asset,
        userId: args.userId,
        error: {
          code: "slack-auth-unavailable",
          message: "Slack is not connected, so this file cannot be imported",
          retryable: true,
        },
      });
      return canonicalSlackInputResult(asset, args.position);
    }
    const downloadUrl = args.file.url_private_download;
    if (!downloadUrl) {
      throw new Error("Canonical Slack input download URL is missing");
    }

    asset = await resetCanonicalInputPending(db, {
      asset,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (
      asset.materializationStatus === "ready" ||
      (asset.materializationStatus === "failed" &&
        asset.materializationError?.retryable === false)
    ) {
      return canonicalSlackInputResult(asset, args.position);
    }

    return set(
      importCanonicalSlackInputFile$,
      {
        asset,
        userId: args.userId,
        position: args.position,
        downloadUrl,
        botToken: args.botToken,
        contentType,
      },
      signal,
    );
  },
);

export const materializeCanonicalSlackInputAssets$ = command(
  async (
    { set },
    args: Omit<CanonicalSlackInputFileArgs, "file" | "position"> & {
      readonly files: readonly SlackFile[];
    },
    signal: AbortSignal,
  ): Promise<readonly CanonicalSlackInputAsset[]> => {
    const assets: CanonicalSlackInputAsset[] = [];
    for (const [position, file] of args.files.entries()) {
      const asset = await set(
        materializeCanonicalSlackInputFile$,
        { ...args, file, position },
        signal,
      );
      signal.throwIfAborted();
      if (asset) {
        assets.push(asset);
      }
    }
    return assets;
  },
);

export async function attachCanonicalAssetsToMessage(
  db: Db,
  messageId: string,
  assets: readonly CanonicalSlackInputAsset[],
): Promise<void> {
  if (assets.length === 0) {
    return;
  }
  await db
    .insert(chatMessageAssetRefs)
    .values(
      assets.map((asset) => {
        return {
          chatMessageId: messageId,
          assetId: asset.assetId,
          position: asset.position,
        };
      }),
    )
    .onConflictDoNothing();
}

export async function canonicalSlackAssetsEnabled(
  db: ReadonlyDb,
  args: { readonly orgId: string; readonly userId: string },
): Promise<boolean> {
  return isFeatureEnabled(
    FeatureSwitchKey.CanonicalSlackAssets,
    await loadUserFeatureSwitchContext(db, args.orgId, args.userId),
  );
}

interface HistoricalCanonicalSlackAssetsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly messageIds: readonly string[];
}

function loadHistoricalSlackRows(
  db: Db,
  args: HistoricalCanonicalSlackAssetsArgs,
) {
  return db
    .select({
      messageId: slackChatIngress.id,
      payload: slackChatIngress.payload,
      workspaceId: slackOrgConnections.slackWorkspaceId,
      channelId: slackChatThreadRoutes.channelId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
    })
    .from(slackChatIngress)
    .innerJoin(
      slackChatThreadRoutes,
      eq(slackChatThreadRoutes.id, slackChatIngress.routeId),
    )
    .innerJoin(
      slackOrgConnections,
      eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
    )
    .leftJoin(
      slackOrgInstallations,
      and(
        eq(
          slackOrgInstallations.slackWorkspaceId,
          slackOrgConnections.slackWorkspaceId,
        ),
        eq(slackOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        inArray(slackChatIngress.id, [...args.messageIds]),
        eq(slackChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(slackChatThreadRoutes.userId, args.userId),
        eq(slackChatThreadRoutes.backend, "canonical"),
      ),
    );
}

function loadHistoricalCanonicalAssetRefs(
  db: Db,
  args: HistoricalCanonicalSlackAssetsArgs,
) {
  return db
    .select({
      messageId: chatMessageAssetRefs.chatMessageId,
      position: chatMessageAssetRefs.position,
      status: runUploadedFiles.materializationStatus,
      error: runUploadedFiles.materializationError,
    })
    .from(chatMessageAssetRefs)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, chatMessageAssetRefs.assetId),
    )
    .where(
      and(
        inArray(chatMessageAssetRefs.chatMessageId, [...args.messageIds]),
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
      ),
    );
}

export const materializeHistoricalCanonicalSlackAssets$ = command(
  async (
    { set },
    args: HistoricalCanonicalSlackAssetsArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (args.messageIds.length === 0) {
      return false;
    }
    const db = set(writeDb$);
    if (!(await canonicalSlackAssetsEnabled(db, args))) {
      return false;
    }
    signal.throwIfAborted();

    const rows = await loadHistoricalSlackRows(db, args);
    signal.throwIfAborted();
    if (rows.length === 0) {
      return false;
    }
    const refs = await loadHistoricalCanonicalAssetRefs(db, args);
    signal.throwIfAborted();
    const refByMessageAndPosition = new Map(
      refs.map((ref) => {
        return [`${ref.messageId}:${String(ref.position)}`, ref] as const;
      }),
    );

    const featureContext = await loadUserFeatureSwitchContext(
      db,
      args.orgId,
      args.userId,
    );
    signal.throwIfAborted();
    const tokens = new Map<string, string>();
    let materialized = false;
    for (const row of rows) {
      const parsed = historicalSlackEventSchema.parse(
        JSON.parse(row.payload) as unknown,
      );
      const files = parsed.event.files ?? [];
      if (files.length === 0) {
        continue;
      }
      const needsMaterialization = files.some((_file, position) => {
        const ref = refByMessageAndPosition.get(
          `${row.messageId}:${String(position)}`,
        );
        return (
          !ref ||
          ref.status === "pending" ||
          (ref.status === "failed" && ref.error?.retryable !== false)
        );
      });
      if (!needsMaterialization) {
        continue;
      }
      if (
        parsed.team_id !== row.workspaceId ||
        parsed.event.channel !== row.channelId
      ) {
        throw new Error(
          "Historical canonical Slack payload does not match its route",
        );
      }
      const encryptedBotToken = row.encryptedBotToken;
      let botToken = encryptedBotToken
        ? tokens.get(encryptedBotToken)
        : undefined;
      if (encryptedBotToken && !botToken) {
        botToken = await decryptPersistentSecretValue(
          encryptedBotToken,
          featureContext,
        );
        tokens.set(encryptedBotToken, botToken);
      }
      signal.throwIfAborted();
      const assets = await set(
        materializeCanonicalSlackInputAssets$,
        {
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: args.chatThreadId,
          workspaceId: row.workspaceId,
          channelId: row.channelId,
          messageTs: parsed.event.ts,
          botToken,
          files,
        },
        signal,
      );
      signal.throwIfAborted();
      await attachCanonicalAssetsToMessage(db, row.messageId, assets);
      signal.throwIfAborted();
      materialized ||= assets.length > 0;
    }
    return materialized;
  },
);

interface PrepareCanonicalPublishedAssetArgs {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly operationId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly checksumSha256: string;
  readonly destination: {
    readonly channelId: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  };
}

interface PreparedCanonicalPublishedAsset {
  readonly assetId: string;
  readonly operationId: string;
  readonly uploadUrl?: string;
  readonly url: string;
}

async function ensureCanonicalPublishedAsset(
  db: Db,
  args: PrepareCanonicalPublishedAssetArgs,
  context: {
    readonly scope: string;
    readonly source: RunUploadedFileSource;
    readonly chatThreadId: string | null;
  },
): Promise<CanonicalAssetRow> {
  const proposedAssetId = randomUUID();
  const proposedStorageKey = buildArtifactKey(
    args.userId,
    proposedAssetId,
    sanitizeArtifactFilename(args.filename),
  );
  const [inserted] = await db
    .insert(runUploadedFiles)
    .values({
      id: proposedAssetId,
      runId: args.runId,
      chatThreadId: context.chatThreadId,
      source: context.source,
      externalId: args.operationId,
      userId: args.userId,
      orgId: args.orgId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.size,
      url: null,
      metadata: {},
      assetVersion: CANONICAL_ASSET_VERSION,
      classification: "published-output",
      accessLevel: "published",
      materializationStatus: "pending",
      checksumSha256: args.checksumSha256,
      storageKey: proposedStorageKey,
      provenance: { provider: "agent" },
      materializationError: null,
      idempotencyScope: context.scope,
      idempotencyKey: args.operationId,
    })
    .onConflictDoNothing({
      target: [
        runUploadedFiles.userId,
        runUploadedFiles.idempotencyScope,
        runUploadedFiles.idempotencyKey,
      ],
      where: eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
    })
    .returning(canonicalAssetSelection());
  const asset =
    inserted ??
    (await canonicalAssetByIdentity(db, {
      userId: args.userId,
      scope: context.scope,
      key: args.operationId,
    }));
  if (!asset) {
    throw new Error("Canonical publication asset conflict is missing");
  }
  if (
    asset.filename !== args.filename ||
    asset.contentType !== args.contentType ||
    asset.sizeBytes !== args.size ||
    asset.checksumSha256 !== args.checksumSha256
  ) {
    throw new Error("Upload operation identity was reused for another file");
  }
  if (!asset.storageKey) {
    throw new Error("Canonical publication storage key is missing");
  }
  return asset;
}

async function ensureCanonicalSlackDelivery(
  db: Db,
  assetId: string,
  args: PrepareCanonicalPublishedAssetArgs,
): Promise<void> {
  await db
    .insert(canonicalAssetDeliveries)
    .values({
      assetId,
      provider: "slack",
      operationId: args.operationId,
      status: "pending",
      destination: args.destination,
    })
    .onConflictDoNothing({
      target: [
        canonicalAssetDeliveries.assetId,
        canonicalAssetDeliveries.provider,
        canonicalAssetDeliveries.operationId,
      ],
    });
  const [delivery] = await db
    .select({ destination: canonicalAssetDeliveries.destination })
    .from(canonicalAssetDeliveries)
    .where(
      and(
        eq(canonicalAssetDeliveries.assetId, assetId),
        eq(canonicalAssetDeliveries.provider, "slack"),
        eq(canonicalAssetDeliveries.operationId, args.operationId),
      ),
    )
    .limit(1);
  if (!delivery) {
    throw new Error("Canonical Slack delivery is missing");
  }
  if (
    delivery.destination.channelId !== args.destination.channelId ||
    delivery.destination.threadTs !== args.destination.threadTs ||
    delivery.destination.title !== args.destination.title ||
    delivery.destination.initialComment !== args.destination.initialComment
  ) {
    throw new Error(
      "Upload operation identity was reused for another Slack destination",
    );
  }
}

export const prepareCanonicalPublishedAsset$ = command(
  async (
    { get, set },
    args: PrepareCanonicalPublishedAssetArgs,
    signal: AbortSignal,
  ): Promise<PreparedCanonicalPublishedAsset> => {
    const db = set(writeDb$);
    const scope = `run:${args.runId}`;
    const source = await sourceForRun(db, args.runId, "slack", signal);
    const [run] = await db
      .select({ chatThreadId: zeroRuns.chatThreadId })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, args.runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run) {
      throw new Error("Canonical publication run does not exist");
    }

    const asset = await ensureCanonicalPublishedAsset(db, args, {
      scope,
      source,
      chatThreadId: run.chatThreadId,
    });
    signal.throwIfAborted();
    await ensureCanonicalSlackDelivery(db, asset.id, args);
    signal.throwIfAborted();
    const storageKey = asset.storageKey;
    if (!storageKey) {
      throw new Error("Canonical publication storage key is missing");
    }

    const url = buildFileUrl(
      args.userId,
      asset.id,
      sanitizeArtifactFilename(args.filename),
    );
    if (asset.materializationStatus === "ready") {
      return {
        assetId: asset.id,
        operationId: args.operationId,
        url,
      };
    }

    await db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "pending",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(runUploadedFiles.id, asset.id));
    signal.throwIfAborted();
    const uploadUrl = await get(
      generatePresignedPutUrl(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        storageKey,
        args.contentType,
        CANONICAL_UPLOAD_URL_TTL_SECONDS,
        true,
      ),
    );
    signal.throwIfAborted();
    return {
      assetId: asset.id,
      operationId: args.operationId,
      uploadUrl,
      url,
    };
  },
);

type MaterializeCanonicalPublishedAssetResult =
  | {
      readonly ok: true;
      readonly assetId: string;
      readonly url: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export const materializeCanonicalPublishedAsset$ = command(
  async (
    { get, set },
    args: {
      readonly assetId: string;
      readonly operationId: string;
      readonly runId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<MaterializeCanonicalPublishedAssetResult> => {
    const db = set(writeDb$);
    const [asset] = await db
      .select(canonicalAssetSelection())
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.id, args.assetId),
          eq(runUploadedFiles.userId, args.userId),
          eq(runUploadedFiles.runId, args.runId),
          eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
          eq(runUploadedFiles.classification, "published-output"),
          eq(runUploadedFiles.idempotencyKey, args.operationId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!asset?.storageKey || !asset.filename) {
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "Canonical publication asset was not found",
      };
    }
    const url = buildFileUrl(
      args.userId,
      asset.id,
      sanitizeArtifactFilename(asset.filename),
    );
    if (asset.materializationStatus === "ready") {
      await set(syncArtifactCatalogForFile$, asset.id, signal);
      return { ok: true, assetId: asset.id, url };
    }

    const head = await get(
      s3ObjectHead(env("R2_USER_ARTIFACTS_BUCKET_NAME"), asset.storageKey),
    );
    signal.throwIfAborted();
    const expectedSize = asset.sizeBytes;
    if (
      head.kind === "missing" ||
      head.contentLength === undefined ||
      (expectedSize !== null && head.contentLength !== expectedSize)
    ) {
      const error = {
        code: "storage-verification-failed",
        message:
          head.kind === "missing"
            ? "Canonical upload was not found"
            : "Canonical upload size did not match",
        retryable: true,
      } as const;
      await db
        .update(runUploadedFiles)
        .set({
          materializationStatus: "failed",
          materializationError: error,
          updatedAt: sql`now()`,
        })
        .where(eq(runUploadedFiles.id, asset.id));
      signal.throwIfAborted();
      return { ok: false, code: error.code, message: error.message };
    }

    await db
      .update(runUploadedFiles)
      .set({
        url,
        sizeBytes: head.contentLength,
        materializationStatus: "ready",
        materializationError: null,
        updatedAt: sql`now()`,
      })
      .where(eq(runUploadedFiles.id, asset.id));
    signal.throwIfAborted();
    await set(syncArtifactCatalogForFile$, asset.id, signal);
    await publishArtifactsChangedForRun(db, args.runId, signal);
    return { ok: true, assetId: asset.id, url };
  },
);
