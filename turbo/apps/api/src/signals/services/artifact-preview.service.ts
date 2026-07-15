import { command } from "ccstate";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { FeatureSwitchKey, isFeatureEnabled } from "@vm0/core";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";

import { env } from "../../lib/env";
import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { putS3Object } from "../external/s3";
import { tapError } from "../utils";
import {
  loadUserFeatureSwitchContext,
  userFeatureSwitchContext,
} from "./feature-switches.service";
import { renderHostedBrowserSnapshot } from "./hosted-browser-renderer.service";
import { publishArtifactsChangedForRun } from "./run-uploaded-files.service";

const log = logger("artifacts:preview");

// Browser rendering is slow (seconds per page), so keep each cron sweep small
// enough to finish within the function's time budget. The sweep is only a
// backfill / retry safety net behind the deploy-time trigger, so steady-state
// batches are tiny.
const PREVIEW_BATCH_SIZE = 10;
const PREVIEW_SCAN_PAGE_SIZE = 50;
const PREVIEW_IMAGE_CONTENT_TYPE = "image/webp";
const PREVIEW_IMAGE_EXTENSION = "webp";
const PREVIEW_IMAGE_BASENAME = "preview-v2";

// Videos are immutable, so a fixed poster key (no versioning) is fine. The
// Cloudflare Media Transformations frame endpoint only outputs jpg/png.
const VIDEO_POSTER_FILENAME = "poster.jpg";
const VIDEO_POSTER_CONTENT_TYPE = "image/jpeg";

interface PreviewCandidateCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface RenderArtifactPreviewArgs {
  // The run_uploaded_files row id; also namespaces the R2 object key.
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string | null;
  readonly url: string;
  // Discriminates the renderer: `video/*` extracts a poster frame, otherwise a
  // Browser Rendering page screenshot.
  readonly contentType: string | null;
  // Versions the preview key so each deployment gets a fresh, CDN-cache-busting
  // URL instead of overwriting a stale object at a fixed key.
  readonly deploymentId: string | null;
}

// Version the preview object by renderer and deployment so both renderer
// upgrades and site redeploys produce a fresh CDN URL.
function previewImageFilename(deploymentId: string | null): string {
  const base = deploymentId
    ? `${PREVIEW_IMAGE_BASENAME}-${deploymentId}`
    : PREVIEW_IMAGE_BASENAME;
  return `${base}.${PREVIEW_IMAGE_EXTENSION}`;
}

function isVideoContentType(contentType: string | null): boolean {
  return contentType?.startsWith("video/") ?? false;
}

// Extract a poster frame from a video via Cloudflare Media Transformations.
// This is a public transform URL on the artifacts CDN (no auth), the video
// sibling of the `/cdn-cgi/image/` resizing already used for images.
async function extractVideoPoster(
  videoUrl: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const base = env("PUBLIC_ARTIFACTS_BASE_URL").replace(/\/+$/, "");
  const transformUrl = `${base}/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${videoUrl}`;
  const response = await fetch(transformUrl, { signal });
  if (!response.ok) {
    throw new Error(
      `media frame extraction failed (${response.status}): ${await response.text()}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function isHtmlArtifactPreviewEnabledForOwner(
  db: ReadonlyDb,
  args: {
    readonly orgId: string | null;
    readonly userId: string;
  },
): Promise<boolean> {
  const featureCtx = await loadUserFeatureSwitchContext(
    db,
    args.orgId ?? "",
    args.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ArtifactPreviewImage, featureCtx);
}

function previewCandidateWhere(cursor?: PreviewCandidateCursor) {
  const conditions = [
    sql`${runUploadedFiles.url} IS NOT NULL`,
    // Re-render HTML previews created by the previous renderer so the new key
    // also bypasses cached challenge images. Video posters remain null-only.
    sql`((
      ${runUploadedFiles.metadata}->>'artifactKind' IN ('hosted-site', 'presentation-html')
      AND (
        ${runUploadedFiles.previewImageUrl} IS NULL
        OR ${runUploadedFiles.previewImageUrl} NOT LIKE ${`%/${PREVIEW_IMAGE_BASENAME}%`}
      )
    ) OR (
      jsonb_typeof(${runUploadedFiles.metadata}->'generatedBy') = 'string'
      AND ${runUploadedFiles.contentType} LIKE 'video/%'
      AND ${runUploadedFiles.previewImageUrl} IS NULL
    ))`,
    // Grace window: skip rows touched in the last 2 minutes so the deploy-time
    // fast path can finish first. The cron only picks up missing or superseded
    // previews, avoiding a duplicate render racing the deploy trigger.
    sql`${runUploadedFiles.updatedAt} < now() - interval '2 minutes'`,
  ];

  if (cursor) {
    const cursorCondition = or(
      lt(runUploadedFiles.createdAt, cursor.createdAt),
      and(
        eq(runUploadedFiles.createdAt, cursor.createdAt),
        lt(runUploadedFiles.id, cursor.id),
      ),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  return and(...conditions);
}

async function renderArtifactSnapshot(
  token: string,
  wafSecret: string,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const snapshot = await renderHostedBrowserSnapshot(
    {
      token,
      wafSecret,
      url,
      formats: ["content", "screenshot"],
    },
    signal,
  );
  if (!snapshot.screenshot) {
    throw new Error("browser-rendering snapshot did not return a screenshot");
  }
  return Buffer.from(snapshot.screenshot, "base64");
}

/**
 * Render a static preview image for a single hosted-site/HTML artifact row,
 * upload it to the user-artifacts R2 bucket next to the artifact, and persist
 * the CDN URL on the row. Returns false (no-op) when the browser-rendering
 * token is unset. Used by both the deploy-time trigger (fast path) and the cron
 * sweep (backfill / retry), keyed by the row id so it always targets the exact
 * artifact of that run.
 */
const renderAndStoreArtifactPreview$ = command(
  async (
    { get, set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const isVideo = isVideoContentType(args.contentType);
    if (!isVideo) {
      // Resolve the HTML preview switch against the artifact owner's context,
      // including per-user Lab overrides. Video posters are fully rolled out.
      const featureCtx = await get(
        userFeatureSwitchContext(args.orgId ?? "", args.userId),
      );
      signal.throwIfAborted();
      if (
        !isFeatureEnabled(FeatureSwitchKey.ArtifactPreviewImage, featureCtx)
      ) {
        return false;
      }
    }

    let image: Buffer;
    let filename: string;
    let contentType: string;
    if (isVideo) {
      image = await extractVideoPoster(args.url, signal);
      filename = VIDEO_POSTER_FILENAME;
      contentType = VIDEO_POSTER_CONTENT_TYPE;
    } else {
      const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
      if (!token) {
        return false;
      }
      const wafSecret = env("ARTIFACT_PREVIEW_WAF_SECRET");
      if (!wafSecret) {
        throw new Error(
          "ARTIFACT_PREVIEW_WAF_SECRET is required when browser rendering is configured",
        );
      }
      image = await renderArtifactSnapshot(token, wafSecret, args.url, signal);
      filename = previewImageFilename(args.deploymentId);
      contentType = PREVIEW_IMAGE_CONTENT_TYPE;
    }
    signal.throwIfAborted();

    const key = buildArtifactKey(args.userId, args.id, filename);
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key,
        image,
        contentType,
      ),
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    await db
      .update(runUploadedFiles)
      .set({
        previewImageUrl: buildFileUrl(args.userId, args.id, filename),
        updatedAt: nowDate(),
      })
      .where(eq(runUploadedFiles.id, args.id));
    signal.throwIfAborted();

    await publishArtifactsChangedForRun(db, args.runId, signal);
    return true;
  },
);

/**
 * Fire-and-forget the deploy-time preview render on a detached signal via
 * waitUntil, so it runs to completion after the deploy response returns rather
 * than being cancelled with the request. No-op when there is nothing to render.
 */
export const scheduleArtifactPreviewRender$ = command(
  ({ set }, args: RenderArtifactPreviewArgs | null): void => {
    if (!args) {
      return;
    }
    waitUntil(
      tapError(
        set(renderAndStoreArtifactPreview$, args, new AbortController().signal),
        (error) => {
          log.warn("Failed to render artifact preview", {
            artifactId: args.id,
            url: args.url,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    );
  },
);

/**
 * Backfill / retry sweep: render previews that are missing, failed during the
 * deploy-time trigger, or were produced by an older HTML renderer. Best-effort
 * per artifact — a failure leaves the row eligible for the next sweep. Returns
 * the count generated.
 */
export const generateArtifactPreviews$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    let generated = 0;
    let cursor: PreviewCandidateCursor | undefined;
    const htmlPreviewEnabledByOwner = new Map<string, boolean>();

    while (generated < PREVIEW_BATCH_SIZE) {
      const rows = await db
        .select({
          id: runUploadedFiles.id,
          runId: runUploadedFiles.runId,
          userId: runUploadedFiles.userId,
          orgId: runUploadedFiles.orgId,
          url: runUploadedFiles.url,
          contentType: runUploadedFiles.contentType,
          createdAt: runUploadedFiles.createdAt,
          deploymentId: sql<
            string | null
          >`${runUploadedFiles.metadata}->>'deploymentId'`,
        })
        .from(runUploadedFiles)
        .where(previewCandidateWhere(cursor))
        .orderBy(desc(runUploadedFiles.createdAt), desc(runUploadedFiles.id))
        .limit(PREVIEW_SCAN_PAGE_SIZE);
      signal.throwIfAborted();
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        cursor = { createdAt: row.createdAt, id: row.id };
        if (!row.url) {
          continue;
        }

        if (!isVideoContentType(row.contentType)) {
          // HTML preview generation remains gated and is cached per owner.
          const ownerKey = `${row.orgId ?? ""}:${row.userId}`;
          let enabled = htmlPreviewEnabledByOwner.get(ownerKey);
          if (enabled === undefined) {
            enabled = await isHtmlArtifactPreviewEnabledForOwner(db, {
              orgId: row.orgId,
              userId: row.userId,
            });
            htmlPreviewEnabledByOwner.set(ownerKey, enabled);
            signal.throwIfAborted();
          }
          if (!enabled) {
            continue;
          }
        }

        const succeeded = await tapError(
          set(
            renderAndStoreArtifactPreview$,
            {
              id: row.id,
              runId: row.runId,
              userId: row.userId,
              orgId: row.orgId,
              url: row.url,
              contentType: row.contentType,
              deploymentId: row.deploymentId,
            },
            signal,
          ),
          (error) => {
            log.warn("Failed to render artifact preview", {
              artifactId: row.id,
              url: row.url,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        );
        signal.throwIfAborted();
        if (succeeded) {
          generated++;
        }
        if (generated >= PREVIEW_BATCH_SIZE) {
          break;
        }
      }
    }

    return generated;
  },
);
