import { command } from "ccstate";
import type { HostedArtifactKind } from "@vm0/api-contracts/contracts/zero-host";
import { eq, sql } from "drizzle-orm";
import {
  RUN_UPLOADED_FILE_SOURCES,
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { type Db, writeDb$ } from "../external/db";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import {
  scheduleVideoArtifactPreviewRender$,
  type VideoArtifactPreviewRenderArgs,
} from "./artifact-preview.service";

interface RecordWebUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string | null | undefined;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly s3Key: string;
  readonly metadata: Record<string, unknown>;
}

interface RecordHostedSiteArtifactArgs {
  readonly runId: string | null | undefined;
  readonly userId: string;
  readonly orgId: string;
  readonly artifactKind: HostedArtifactKind;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly deploymentVersion: number | null;
  readonly site: string;
  readonly publicSlug: string;
  readonly aliasUrl: string;
  readonly url: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly entrypoint: string;
  readonly spaFallback: boolean;
}

function isRunUploadedFileSource(
  source: string | null | undefined,
): source is RunUploadedFileSource {
  if (!source) {
    return false;
  }
  return RUN_UPLOADED_FILE_SOURCES.some((candidate) => {
    return candidate === source;
  });
}

export async function sourceForRun(
  writeDb: Db,
  runId: string,
  fallback: RunUploadedFileSource,
  signal: AbortSignal,
): Promise<RunUploadedFileSource> {
  const [run] = await writeDb
    .select({ triggerSource: zeroRuns.triggerSource })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return isRunUploadedFileSource(run?.triggerSource)
    ? run.triggerSource
    : fallback;
}

interface RecordedUploadedFile {
  readonly id: string;
  readonly previewImageUrl: string | null;
}

function videoArtifactPreviewArgs(
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string | null | undefined;
    readonly url: string | null;
    readonly contentType: string | null;
  },
  row: RecordedUploadedFile | undefined,
): VideoArtifactPreviewRenderArgs | null {
  if (
    !row ||
    row.previewImageUrl ||
    !args.orgId ||
    !args.url ||
    !args.contentType?.startsWith("video/")
  ) {
    return null;
  }
  return {
    id: row.id,
    runId: args.runId,
    userId: args.userId,
    orgId: args.orgId,
    url: args.url,
    contentType: args.contentType,
  };
}

/**
 * Insert (or upsert) a `run_uploaded_files` row for a hosted website
 * artifact. The artifact URL points at the hosted `*.sites` deployment;
 * no user-storage upload is created. Versioned deployments use their immutable
 * deployment ID for idempotency; legacy deployments continue using the alias
 * URL during the rollout window.
 */
export const recordHostedSiteArtifact$ = command(
  async (
    { set },
    args: RecordHostedSiteArtifactArgs,
    signal: AbortSignal,
  ): Promise<RecordedUploadedFile | null> => {
    if (!args.runId) {
      return null;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "web", signal);
    const externalId =
      args.deploymentVersion === null ? args.url : args.deploymentId;
    const filename =
      args.deploymentVersion === null
        ? `${args.publicSlug}.html`
        : `${args.site}-v${args.deploymentVersion}.html`;

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename,
        contentType: "text/html",
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: {
          generatedBy: "zero-official-website",
          artifactKind: args.artifactKind,
          siteId: args.siteId,
          deploymentId: args.deploymentId,
          deploymentVersion: args.deploymentVersion,
          aliasUrl: args.aliasUrl,
          publicSlug: args.publicSlug,
          fileCount: args.fileCount,
          entrypoint: args.entrypoint,
          spaFallback: args.spaFallback,
        },
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename,
          contentType: "text/html",
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: {
            generatedBy: "zero-official-website",
            artifactKind: args.artifactKind,
            siteId: args.siteId,
            deploymentId: args.deploymentId,
            deploymentVersion: args.deploymentVersion,
            aliasUrl: args.aliasUrl,
            publicSlug: args.publicSlug,
            fileCount: args.fileCount,
            entrypoint: args.entrypoint,
            spaFallback: args.spaFallback,
          },
          // Legacy redeploys reuse a mutable alias row. Preserve the preview
          // when the same deployment is completed again, but clear it when a
          // new deployment takes over that row. Versioned rows are immutable
          // and keep their own preview.
          ...(args.deploymentVersion === null
            ? {
                previewImageUrl: sql`case
                  when ${runUploadedFiles.metadata}->>'deploymentId' = ${args.deploymentId}
                  then ${runUploadedFiles.previewImageUrl}
                  else null
                end`,
              }
            : {}),
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    return row ?? null;
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for a successful web
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (ordinary
 * session callers without a run-scoped token).
 *
 * Verbatim port of apps/web/src/lib/zero/uploads/run-uploaded-files.ts.
 * Idempotency contract is upsert on (runId, source, externalId).
 */
export const recordWebUploadedFile$ = command(
  async (
    { set },
    args: RecordWebUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "web", signal);

    const metadata = {
      ...args.metadata,
      s3Key: args.s3Key,
    };

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId ?? null,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId ?? null,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

interface RecordTelegramUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Insert (or upsert) a `run_uploaded_files` row for a Telegram-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 *
 * Verbatim port of apps/web/src/lib/zero/uploads/run-uploaded-files.ts
 * scoped to the `"telegram"` source. Idempotency contract is upsert on
 * (runId, source, externalId).
 */
export const recordTelegramUploadedFile$ = command(
  async (
    { set },
    args: RecordTelegramUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "telegram", signal);

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

interface RecordSlackUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly url: string | null;
  readonly metadata: Record<string, unknown>;
}

interface RecordFeishuUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

interface RecordTeamsUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

interface RecordAgentPhoneUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

interface RecordGithubUploadedFileArgs {
  readonly runId: string | undefined;
  readonly externalId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly metadata: Record<string, unknown>;
}

export const recordGithubUploadedFile$ = command(
  async (
    { set },
    args: RecordGithubUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "github", signal);

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

export const recordFeishuUploadedFile$ = command(
  async (
    { set },
    args: RecordFeishuUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "feishu", signal);

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

export const recordTeamsUploadedFile$ = command(
  async (
    { set },
    args: RecordTeamsUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "teams", signal);

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for an AgentPhone-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 */
export const recordAgentPhoneUploadedFile$ = command(
  async (
    { set },
    args: RecordAgentPhoneUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(
      writeDb,
      args.runId,
      "agentphone",
      signal,
    );

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);

/**
 * Insert (or upsert) a `run_uploaded_files` row for a Slack-delivered
 * upload, then publish the chat-thread artifacts-changed signal if the
 * run is linked to a thread. No-op when `runId` is undefined (sandbox
 * callers without a run-scoped token).
 *
 * Mirrors recordTelegramUploadedFile$ but scoped to the `"slack"` source
 * and allows nullable metadata fields because Slack's files.info may not
 * surface every attribute. Idempotency contract is upsert on
 * (runId, source, externalId).
 */
export const recordSlackUploadedFile$ = command(
  async (
    { set },
    args: RecordSlackUploadedFileArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.runId) {
      return;
    }
    const writeDb = set(writeDb$);
    const source = await sourceForRun(writeDb, args.runId, "slack", signal);

    const [row] = await writeDb
      .insert(runUploadedFiles)
      .values({
        runId: args.runId,
        source,
        externalId: args.externalId,
        userId: args.userId,
        orgId: args.orgId,
        filename: args.filename,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
        url: args.url,
        metadata: args.metadata,
      })
      .onConflictDoUpdate({
        target: [
          runUploadedFiles.runId,
          runUploadedFiles.source,
          runUploadedFiles.externalId,
        ],
        set: {
          userId: args.userId,
          orgId: args.orgId,
          filename: args.filename,
          contentType: args.contentType,
          sizeBytes: args.sizeBytes,
          url: args.url,
          metadata: args.metadata,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: runUploadedFiles.id,
        previewImageUrl: runUploadedFiles.previewImageUrl,
      });
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, row?.id, signal);
    await publishArtifactsChangedForRun(writeDb, args.runId, signal);
    set(
      scheduleVideoArtifactPreviewRender$,
      videoArtifactPreviewArgs(
        {
          runId: args.runId,
          userId: args.userId,
          orgId: args.orgId,
          url: args.url,
          contentType: args.contentType,
        },
        row,
      ),
    );
  },
);
