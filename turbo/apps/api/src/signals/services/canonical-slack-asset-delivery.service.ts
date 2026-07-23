import { command } from "ccstate";
import {
  CANONICAL_ASSET_VERSION,
  canonicalAssetDeliveries,
  runUploadedFiles,
} from "@vm0/db/schema/run-uploaded-file";
import { and, eq, sql } from "drizzle-orm";
import type { WebClient } from "@slack/web-api";

import {
  completeUploadExternal,
  getFileInfo,
  getUploadUrlExternal,
} from "../external/slack-message-client";
import { type Db, writeDb$ } from "../external/db";
import { settle } from "../utils";

interface CanonicalSlackDeliveryRow {
  readonly assetId: string;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  readonly assetUrl: string | null;
  readonly operationId: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly destination: {
    readonly channelId: string;
    readonly threadTs?: string;
    readonly title?: string;
    readonly initialComment?: string;
  };
  readonly externalId: string | null;
  readonly deliveryUrl: string | null;
  readonly lastError: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

type CanonicalSlackDeliveryResult =
  | {
      readonly status: "pending";
      readonly uploadUrl: string;
      readonly fileId: string;
    }
  | {
      readonly status: "delivered";
      readonly fileId: string;
      readonly permalink: string;
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly retryable: boolean;
    };

async function canonicalSlackDeliveryRow(
  db: Db,
  args: {
    readonly assetId: string;
    readonly operationId: string;
    readonly runId: string;
    readonly userId: string;
  },
): Promise<CanonicalSlackDeliveryRow | undefined> {
  const [row] = await db
    .select({
      assetId: runUploadedFiles.id,
      filename: runUploadedFiles.filename,
      sizeBytes: runUploadedFiles.sizeBytes,
      assetUrl: runUploadedFiles.url,
      operationId: canonicalAssetDeliveries.operationId,
      status: canonicalAssetDeliveries.status,
      destination: canonicalAssetDeliveries.destination,
      externalId: canonicalAssetDeliveries.externalId,
      deliveryUrl: canonicalAssetDeliveries.url,
      lastError: canonicalAssetDeliveries.lastError,
    })
    .from(canonicalAssetDeliveries)
    .innerJoin(
      runUploadedFiles,
      eq(runUploadedFiles.id, canonicalAssetDeliveries.assetId),
    )
    .where(
      and(
        eq(runUploadedFiles.id, args.assetId),
        eq(runUploadedFiles.runId, args.runId),
        eq(runUploadedFiles.userId, args.userId),
        eq(runUploadedFiles.assetVersion, CANONICAL_ASSET_VERSION),
        eq(runUploadedFiles.classification, "published-output"),
        eq(runUploadedFiles.materializationStatus, "ready"),
        eq(canonicalAssetDeliveries.provider, "slack"),
        eq(canonicalAssetDeliveries.operationId, args.operationId),
      ),
    )
    .limit(1);
  return row;
}

function deliveredResult(
  row: CanonicalSlackDeliveryRow,
): CanonicalSlackDeliveryResult {
  return {
    status: "delivered",
    fileId: row.externalId ?? "",
    permalink: row.deliveryUrl ?? "",
  };
}

function providerFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Slack request failed";
}

async function markDeliveryFailed(
  db: Db,
  assetId: string,
  error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  },
): Promise<CanonicalSlackDeliveryResult> {
  await db
    .update(canonicalAssetDeliveries)
    .set({
      status: "failed",
      lastError: error,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(canonicalAssetDeliveries.assetId, assetId),
        eq(canonicalAssetDeliveries.provider, "slack"),
      ),
    );
  return {
    status: "failed",
    message: error.message,
    retryable: error.retryable,
  };
}

async function markDeliveryDelivered(
  db: Db,
  row: CanonicalSlackDeliveryRow,
  permalink: string,
): Promise<CanonicalSlackDeliveryResult> {
  await db
    .update(canonicalAssetDeliveries)
    .set({
      status: "delivered",
      url: permalink || null,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(canonicalAssetDeliveries.assetId, row.assetId),
        eq(canonicalAssetDeliveries.provider, "slack"),
        eq(canonicalAssetDeliveries.operationId, row.operationId),
      ),
    );
  return {
    status: "delivered",
    fileId: row.externalId ?? "",
    permalink,
  };
}

async function completeExistingSlackFile(
  db: Db,
  client: WebClient,
  row: CanonicalSlackDeliveryRow,
): Promise<CanonicalSlackDeliveryResult | null> {
  if (!row.externalId) {
    return null;
  }
  const completed = await completeUploadExternal(client, {
    fileId: row.externalId,
    channel: row.destination.channelId,
    threadTs: row.destination.threadTs,
    title: row.destination.title,
    initialComment: row.destination.initialComment,
  });
  if (completed.kind === "slack_error") {
    if (
      completed.error === "file_not_found" ||
      completed.error === "no_file_data"
    ) {
      return null;
    }
    return await markDeliveryFailed(db, row.assetId, {
      code: completed.error,
      message: `Slack delivery failed: ${completed.error}`,
      retryable: true,
    });
  }
  const info = await getFileInfo(client, row.externalId);
  const permalink =
    info.kind === "ok" ? (info.file?.permalink ?? row.deliveryUrl ?? "") : "";
  return await markDeliveryDelivered(db, row, permalink);
}

export const prepareCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: {
      readonly assetId: string;
      readonly operationId: string;
      readonly runId: string;
      readonly userId: string;
      readonly client: WebClient;
    },
    signal: AbortSignal,
  ): Promise<CanonicalSlackDeliveryResult | null> => {
    const db = set(writeDb$);
    const row = await canonicalSlackDeliveryRow(db, args);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    if (row.status === "delivered") {
      return deliveredResult(row);
    }

    const reconciliation = await settle(
      completeExistingSlackFile(db, args.client, row),
      signal,
    );
    signal.throwIfAborted();
    if (!reconciliation.ok) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "slack-request-failed",
        message: providerFailureMessage(reconciliation.error),
        retryable: true,
      });
    }
    const reconciled = reconciliation.value;
    if (reconciled) {
      return reconciled;
    }
    if (!row.filename || row.sizeBytes === null) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "asset-metadata-missing",
        message: "Canonical asset metadata is incomplete",
        retryable: false,
      });
    }

    const preparation = await settle(
      getUploadUrlExternal(args.client, {
        filename: row.filename,
        length: row.sizeBytes,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!preparation.ok) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "slack-request-failed",
        message: providerFailureMessage(preparation.error),
        retryable: true,
      });
    }
    const prepared = preparation.value;
    if (prepared.kind === "slack_error") {
      return await markDeliveryFailed(db, row.assetId, {
        code: prepared.error,
        message: `Slack delivery failed: ${prepared.error}`,
        retryable: true,
      });
    }

    await db
      .update(canonicalAssetDeliveries)
      .set({
        status: "pending",
        externalId: prepared.fileId,
        url: null,
        lastError: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(canonicalAssetDeliveries.assetId, row.assetId),
          eq(canonicalAssetDeliveries.provider, "slack"),
          eq(canonicalAssetDeliveries.operationId, row.operationId),
        ),
      );
    signal.throwIfAborted();
    return {
      status: "pending",
      uploadUrl: prepared.uploadUrl,
      fileId: prepared.fileId,
    };
  },
);

export const completeCanonicalSlackDelivery$ = command(
  async (
    { set },
    args: {
      readonly assetId: string;
      readonly operationId: string;
      readonly runId: string;
      readonly userId: string;
      readonly fileId: string;
      readonly uploadError?: string;
      readonly client: WebClient;
    },
    signal: AbortSignal,
  ): Promise<CanonicalSlackDeliveryResult | null> => {
    const db = set(writeDb$);
    const row = await canonicalSlackDeliveryRow(db, args);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    if (row.status === "delivered") {
      return deliveredResult(row);
    }
    if (row.externalId !== args.fileId) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "delivery-file-mismatch",
        message: "Slack delivery file identity did not match",
        retryable: false,
      });
    }
    if (args.uploadError) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "slack-upload-failed",
        message: args.uploadError,
        retryable: true,
      });
    }

    const completion = await settle(
      completeUploadExternal(args.client, {
        fileId: args.fileId,
        channel: row.destination.channelId,
        threadTs: row.destination.threadTs,
        title: row.destination.title,
        initialComment: row.destination.initialComment,
      }),
      signal,
    );
    signal.throwIfAborted();
    if (!completion.ok) {
      return await markDeliveryFailed(db, row.assetId, {
        code: "slack-request-failed",
        message: providerFailureMessage(completion.error),
        retryable: true,
      });
    }
    const completed = completion.value;
    if (completed.kind === "slack_error") {
      return await markDeliveryFailed(db, row.assetId, {
        code: completed.error,
        message: `Slack delivery failed: ${completed.error}`,
        retryable: true,
      });
    }

    const infoResult = await settle(
      getFileInfo(args.client, args.fileId),
      signal,
    );
    signal.throwIfAborted();
    const permalink =
      infoResult.ok && infoResult.value.kind === "ok"
        ? (infoResult.value.file?.permalink ?? "")
        : "";
    return await markDeliveryDelivered(db, row, permalink);
  },
);
