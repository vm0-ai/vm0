import { command } from "ccstate";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type {
  ArtifactCatalogKind,
  ArtifactDetail,
  ArtifactSummary,
} from "@vm0/api-contracts/contracts/artifact-catalog";
import {
  artifacts,
  imageArtifacts,
  presentationArtifacts,
  videoArtifacts,
  type ArtifactKind,
  type ArtifactThumbnail,
} from "@vm0/db/schema/artifact";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { hostedDeployments, hostedSites } from "@vm0/db/schema/hosted-site";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishArtifactCatalogChanged } from "./artifact-realtime.service";
import { inferMimetype } from "./zero-chat-message-shared.service";

const ARTIFACT_CATALOG_DEFAULT_LIMIT = 60;

/**
 * `generatedBy` markers written by the built-in generation pipelines. They are
 * the only signal that separates an officially generated image or video from an
 * ordinary upload that happens to share a content type.
 */
const OFFICIAL_IMAGE_MARKER = "zero-official-image";
const OFFICIAL_VIDEO_MARKER = "zero-official-video";

const artifactCursorSchema = z.object({
  createdAt: z.string(),
  id: z.string(),
});
type ArtifactCursor = z.infer<typeof artifactCursorSchema>;

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArtifactCursor(raw: string): ArtifactCursor {
  return artifactCursorSchema.parse(
    JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
  );
}

interface CatalogFileRow {
  readonly id: string;
  readonly runId: string | null;
  readonly chatThreadId: string | null;
  readonly userId: string;
  readonly orgId: string | null;
  readonly filename: string | null;
  readonly externalId: string;
  readonly contentType: string | null;
  readonly url: string | null;
  readonly previewImageUrl: string | null;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date;
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The catalog kind a stored file maps to. Ordinary uploads of every media type
 * stay `file`; only the official generation pipelines produce `image`/`video`.
 */
function fileArtifactKind(row: CatalogFileRow): "file" | "image" | "video" {
  const generatedBy = metadataString(row.metadata, "generatedBy");
  if (generatedBy === OFFICIAL_IMAGE_MARKER) {
    return "image";
  }
  if (generatedBy === OFFICIAL_VIDEO_MARKER) {
    return "video";
  }
  return "file";
}

function hostedArtifactKind(
  row: CatalogFileRow,
): "hosted-site" | "presentation" | null {
  const artifactKind = metadataString(row.metadata, "artifactKind");
  if (artifactKind === "hosted-site") {
    return "hosted-site";
  }
  if (artifactKind === "presentation-html") {
    return "presentation";
  }
  return null;
}

function fileThumbnail(row: CatalogFileRow): ArtifactThumbnail | null {
  if (row.previewImageUrl) {
    return { url: row.previewImageUrl };
  }
  const filename = row.filename ?? row.externalId;
  const contentType = row.contentType ?? inferMimetype(filename);
  if (row.url && contentType.startsWith("image/")) {
    return { url: row.url };
  }
  return null;
}

/**
 * The owning vm0 user for an artifact. Chat-backed runs are owned by the thread
 * user, so an artifact produced from a Slack or Feishu message is filed under
 * the vm0 account behind that thread rather than the external sender.
 */
async function resolveChatThreadId(
  db: Db,
  row: CatalogFileRow,
  signal: AbortSignal,
): Promise<string | null> {
  if (row.chatThreadId) {
    return row.chatThreadId;
  }
  if (!row.runId) {
    return null;
  }

  const [run] = await db
    .select({ chatThreadId: zeroRuns.chatThreadId })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, row.runId))
    .limit(1);
  signal.throwIfAborted();
  if (run?.chatThreadId) {
    return run.chatThreadId;
  }

  const [message] = await db
    .select({ chatThreadId: chatMessages.chatThreadId })
    .from(chatMessages)
    .where(eq(chatMessages.runId, row.runId))
    .orderBy(asc(chatMessages.seqId))
    .limit(1);
  signal.throwIfAborted();
  return message?.chatThreadId ?? null;
}

async function resolveAuthorUserId(
  db: Db,
  row: CatalogFileRow,
  signal: AbortSignal,
): Promise<string> {
  const threadId = await resolveChatThreadId(db, row, signal);
  if (!threadId) {
    return row.userId;
  }

  const [thread] = await db
    .select({ userId: chatThreads.userId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  signal.throwIfAborted();
  return thread?.userId ?? row.userId;
}

async function readCatalogFileRow(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<CatalogFileRow | null> {
  const [row] = await db
    .select({
      id: runUploadedFiles.id,
      runId: runUploadedFiles.runId,
      chatThreadId: runUploadedFiles.chatThreadId,
      userId: runUploadedFiles.userId,
      orgId: runUploadedFiles.orgId,
      filename: runUploadedFiles.filename,
      externalId: runUploadedFiles.externalId,
      contentType: runUploadedFiles.contentType,
      url: runUploadedFiles.url,
      previewImageUrl: runUploadedFiles.previewImageUrl,
      metadata: runUploadedFiles.metadata,
      createdAt: runUploadedFiles.createdAt,
    })
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.id, fileId))
    .limit(1);
  signal.throwIfAborted();
  return row ?? null;
}

interface UpsertArtifactArgs {
  readonly db: Db;
  readonly kind: ArtifactKind;
  readonly entityId: string;
  readonly orgId: string;
  readonly authorUserId: string;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly createdAt: Date;
}

/**
 * Idempotent registry write. `created_at` is never updated, so re-running the
 * sync (redeploy, preview render, backfill replay) keeps the artifact in its
 * original list position.
 */
async function upsertArtifact(args: UpsertArtifactArgs): Promise<void> {
  await args.db
    .insert(artifacts)
    .values({
      kind: args.kind,
      entityId: args.entityId,
      orgId: args.orgId,
      authorUserId: args.authorUserId,
      title: args.title,
      thumbnail: args.thumbnail,
      createdAt: args.createdAt,
    })
    .onConflictDoUpdate({
      target: [artifacts.kind, artifacts.entityId],
      set: {
        orgId: args.orgId,
        authorUserId: args.authorUserId,
        title: args.title,
        thumbnail: args.thumbnail,
        updatedAt: nowDate(),
      },
    });
}

async function upsertGeneratedMediaEntity(args: {
  readonly db: Db;
  readonly kind: "image" | "video";
  readonly row: CatalogFileRow;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const model = metadataString(args.row.metadata, "model");
  if (args.kind === "image") {
    const [entity] = await args.db
      .insert(imageArtifacts)
      .values({
        fileId: args.row.id,
        model,
        provider: metadataString(args.row.metadata, "provider"),
      })
      .onConflictDoUpdate({
        target: [imageArtifacts.fileId],
        set: {
          model,
          provider: metadataString(args.row.metadata, "provider"),
          updatedAt: nowDate(),
        },
      })
      .returning({ id: imageArtifacts.id });
    args.signal.throwIfAborted();
    return entity?.id ?? null;
  }

  const durationSeconds = args.row.metadata.durationSeconds;
  const [entity] = await args.db
    .insert(videoArtifacts)
    .values({
      fileId: args.row.id,
      model,
      durationSeconds:
        typeof durationSeconds === "number"
          ? Math.round(durationSeconds)
          : null,
    })
    .onConflictDoUpdate({
      target: [videoArtifacts.fileId],
      set: {
        model,
        durationSeconds:
          typeof durationSeconds === "number"
            ? Math.round(durationSeconds)
            : null,
        updatedAt: nowDate(),
      },
    })
    .returning({ id: videoArtifacts.id });
  args.signal.throwIfAborted();
  return entity?.id ?? null;
}

async function upsertPresentationEntity(args: {
  readonly db: Db;
  readonly hostedSiteId: string;
  readonly signal: AbortSignal;
}): Promise<string | null> {
  const [entity] = await args.db
    .insert(presentationArtifacts)
    .values({ hostedSiteId: args.hostedSiteId })
    .onConflictDoUpdate({
      target: [presentationArtifacts.hostedSiteId],
      set: { updatedAt: nowDate() },
    })
    .returning({ id: presentationArtifacts.id });
  args.signal.throwIfAborted();
  return entity?.id ?? null;
}

async function syncHostedArtifact(args: {
  readonly db: Db;
  readonly kind: "hosted-site" | "presentation";
  readonly row: CatalogFileRow;
  readonly orgId: string;
  readonly authorUserId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const siteId = metadataString(args.row.metadata, "siteId");
  if (!siteId) {
    return;
  }
  const [site] = await args.db
    .select({
      id: hostedSites.id,
      slug: hostedSites.slug,
      createdAt: hostedSites.createdAt,
    })
    .from(hostedSites)
    .where(eq(hostedSites.id, siteId))
    .limit(1);
  args.signal.throwIfAborted();
  if (!site) {
    return;
  }

  const entityId =
    args.kind === "presentation"
      ? await upsertPresentationEntity({
          db: args.db,
          hostedSiteId: site.id,
          signal: args.signal,
        })
      : site.id;
  if (!entityId) {
    return;
  }

  await upsertArtifact({
    db: args.db,
    kind: args.kind,
    entityId,
    orgId: args.orgId,
    authorUserId: args.authorUserId,
    title: site.slug,
    thumbnail: args.row.previewImageUrl
      ? { url: args.row.previewImageUrl }
      : null,
    createdAt: site.createdAt,
  });
  args.signal.throwIfAborted();
}

/**
 * Maintain the catalog entry for one stored file. Safe to call repeatedly: the
 * upload path, the deploy path, and the deferred preview render all funnel
 * through here, and each call recomputes the artifact from the file row.
 *
 * Hosted-site and presentation projections collapse onto their `hosted_sites`
 * row, so redeploying a site updates one artifact instead of adding another.
 */
export const syncArtifactCatalogForFile$ = command(
  async (
    { set },
    fileId: string | null | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!fileId) {
      return;
    }
    const db = set(writeDb$);
    const row = await readCatalogFileRow(db, fileId, signal);
    if (!row?.url || !row.orgId) {
      return;
    }

    const authorUserId = await resolveAuthorUserId(db, row, signal);
    const hostedKind = hostedArtifactKind(row);
    if (hostedKind) {
      await syncHostedArtifact({
        db,
        kind: hostedKind,
        row,
        orgId: row.orgId,
        authorUserId,
        signal,
      });
      await publishArtifactCatalogChanged(authorUserId);
      signal.throwIfAborted();
      return;
    }

    const kind = fileArtifactKind(row);
    const entityId =
      kind === "file"
        ? row.id
        : await upsertGeneratedMediaEntity({ db, kind, row, signal });
    if (!entityId) {
      return;
    }

    await upsertArtifact({
      db,
      kind,
      entityId,
      orgId: row.orgId,
      authorUserId,
      title: row.filename ?? row.externalId,
      thumbnail: fileThumbnail(row),
      createdAt: row.createdAt,
    });
    signal.throwIfAborted();
    await publishArtifactCatalogChanged(authorUserId);
    signal.throwIfAborted();
  },
);

interface ListArtifactCatalogArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly kind?: ArtifactCatalogKind;
}

interface ListArtifactCatalogResult {
  readonly artifacts: readonly ArtifactSummary[];
  readonly nextCursor: string | null;
}

function toArtifactSummary(row: {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly thumbnail: ArtifactThumbnail | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): ArtifactSummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    thumbnail: row.thumbnail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const listArtifactCatalog$ = command(
  async (
    { set },
    args: ListArtifactCatalogArgs,
    signal: AbortSignal,
  ): Promise<ListArtifactCatalogResult> => {
    const db = set(writeDb$);
    const limit = args.limit ?? ARTIFACT_CATALOG_DEFAULT_LIMIT;
    const cursor = args.cursor ? decodeArtifactCursor(args.cursor) : null;
    const rows = await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        title: artifacts.title,
        thumbnail: artifacts.thumbnail,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
          args.kind ? eq(artifacts.kind, args.kind) : undefined,
          cursor
            ? sql`(${artifacts.createdAt}, ${artifacts.id}) < (${cursor.createdAt}::timestamptz AT TIME ZONE 'UTC', ${cursor.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
      .limit(limit + 1);
    signal.throwIfAborted();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.at(-1);
    return {
      artifacts: pageRows.map(toArtifactSummary),
      nextCursor:
        hasMore && lastRow
          ? encodeArtifactCursor({
              createdAt: lastRow.createdAt.toISOString(),
              id: lastRow.id,
            })
          : null,
    };
  },
);

interface GetArtifactCatalogEntryArgs {
  readonly artifactId: string;
  readonly orgId: string;
  readonly userId: string;
}

async function fileDetail(
  db: Db,
  fileId: string,
  signal: AbortSignal,
): Promise<{
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly previewImageUrl: string | null;
} | null> {
  const [row] = await db
    .select({
      id: runUploadedFiles.id,
      externalId: runUploadedFiles.externalId,
      filename: runUploadedFiles.filename,
      contentType: runUploadedFiles.contentType,
      sizeBytes: runUploadedFiles.sizeBytes,
      url: runUploadedFiles.url,
      previewImageUrl: runUploadedFiles.previewImageUrl,
    })
    .from(runUploadedFiles)
    .where(eq(runUploadedFiles.id, fileId))
    .limit(1);
  signal.throwIfAborted();
  if (!row?.url) {
    return null;
  }
  const filename = row.filename ?? row.externalId;
  return {
    id: row.id,
    filename,
    contentType: row.contentType ?? inferMimetype(filename),
    size: row.sizeBytes ?? 0,
    url: row.url,
    previewImageUrl: row.previewImageUrl,
  };
}

async function hostedSiteDetail(
  db: Db,
  hostedSiteId: string,
  signal: AbortSignal,
): Promise<{
  readonly id: string;
  readonly slug: string;
  readonly publicSlug: string;
  readonly url: string;
  readonly deploymentVersion: number | null;
  readonly entrypoint: string;
  readonly spaFallback: boolean;
} | null> {
  const [row] = await db
    .select({
      id: hostedSites.id,
      slug: hostedSites.slug,
      publicSlug: hostedSites.publicSlug,
      deploymentVersion: hostedSites.activeDeploymentVersion,
      url: hostedDeployments.url,
      entrypoint: hostedDeployments.entrypoint,
      spaFallback: hostedDeployments.spaFallback,
    })
    .from(hostedSites)
    .innerJoin(
      hostedDeployments,
      eq(hostedDeployments.id, hostedSites.activeDeploymentId),
    )
    .where(eq(hostedSites.id, hostedSiteId))
    .limit(1);
  signal.throwIfAborted();
  return row ?? null;
}

/**
 * Load one artifact together with its kind entity. The caller check runs on the
 * registry row alone, so every kind shares the same permission rule.
 */
export const getArtifactCatalogEntry$ = command(
  async (
    { set },
    args: GetArtifactCatalogEntryArgs,
    signal: AbortSignal,
  ): Promise<ArtifactDetail | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        id: artifacts.id,
        kind: artifacts.kind,
        entityId: artifacts.entityId,
        title: artifacts.title,
        thumbnail: artifacts.thumbnail,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, args.artifactId),
          eq(artifacts.orgId, args.orgId),
          eq(artifacts.authorUserId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }

    const summary = toArtifactSummary(row);
    if (row.kind === "file") {
      const file = await fileDetail(db, row.entityId, signal);
      return file ? { ...summary, kind: "file", file } : null;
    }

    if (row.kind === "image") {
      const [entity] = await db
        .select({
          fileId: imageArtifacts.fileId,
          model: imageArtifacts.model,
          provider: imageArtifacts.provider,
        })
        .from(imageArtifacts)
        .where(eq(imageArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!entity) {
        return null;
      }
      const file = await fileDetail(db, entity.fileId, signal);
      return file
        ? {
            ...summary,
            kind: "image",
            file,
            model: entity.model,
            provider: entity.provider,
          }
        : null;
    }

    if (row.kind === "video") {
      const [entity] = await db
        .select({
          fileId: videoArtifacts.fileId,
          model: videoArtifacts.model,
          durationSeconds: videoArtifacts.durationSeconds,
        })
        .from(videoArtifacts)
        .where(eq(videoArtifacts.id, row.entityId))
        .limit(1);
      signal.throwIfAborted();
      if (!entity) {
        return null;
      }
      const file = await fileDetail(db, entity.fileId, signal);
      return file
        ? {
            ...summary,
            kind: "video",
            file,
            model: entity.model,
            durationSeconds: entity.durationSeconds,
          }
        : null;
    }

    if (row.kind === "hosted-site") {
      const site = await hostedSiteDetail(db, row.entityId, signal);
      return site ? { ...summary, kind: "hosted-site", site } : null;
    }

    const [entity] = await db
      .select({ hostedSiteId: presentationArtifacts.hostedSiteId })
      .from(presentationArtifacts)
      .where(eq(presentationArtifacts.id, row.entityId))
      .limit(1);
    signal.throwIfAborted();
    if (!entity) {
      return null;
    }
    const site = await hostedSiteDetail(db, entity.hostedSiteId, signal);
    return site ? { ...summary, kind: "presentation", site } : null;
  },
);
