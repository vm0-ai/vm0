import { command } from "ccstate";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
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
import { publishArtifactsChangedForRun } from "./run-uploaded-files.service";

const log = logger("artifacts:preview");

// Browser rendering is slow (seconds per page), so keep each cron sweep small
// enough to finish within the function's time budget. The sweep is only a
// backfill / retry safety net behind the deploy-time trigger, so steady-state
// batches are tiny.
const PREVIEW_BATCH_SIZE = 10;
const PREVIEW_SCAN_PAGE_SIZE = 50;
const PREVIEW_SCAN_MAX_PAGES = 20;
// Render at a full 1280-wide desktop layout for fidelity, but rasterize at half
// resolution (deviceScaleFactor 0.5 -> 640x400) since the grid only shows the
// image a few hundred px wide. WebP keeps the file small (~tens of KB).
const PREVIEW_VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 0.5,
} as const;
const PREVIEW_IMAGE_CONTENT_TYPE = "image/webp";
const PREVIEW_IMAGE_EXTENSION = "webp";

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
  // Versions the preview key so each deployment gets a fresh, CDN-cache-busting
  // URL instead of overwriting a stale object at a fixed key.
  readonly deploymentId: string | null;
}

// Version the preview object by deployment so a redeploy produces a new URL
// (busts the CDN) rather than overwriting the previous deployment's image.
function previewImageFilename(deploymentId: string | null): string {
  const base = deploymentId ? `preview-${deploymentId}` : "preview";
  return `${base}.${PREVIEW_IMAGE_EXTENSION}`;
}

async function isArtifactPreviewEnabledForOwner(
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
    isNull(runUploadedFiles.previewImageUrl),
    sql`${runUploadedFiles.url} IS NOT NULL`,
    sql`${runUploadedFiles.metadata}->>'artifactKind' IN ('hosted-site', 'presentation-html')`,
    // Grace window: skip rows touched in the last 2 minutes so the deploy-time
    // fast path can finish first. The cron only picks up rows it demonstrably
    // failed on, plus pre-feature backfill (already old), avoiding a duplicate
    // render racing the deploy trigger.
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

async function renderArtifactScreenshot(
  token: string,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const accountId = env("R2_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/screenshot`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        viewport: PREVIEW_VIEWPORT,
        gotoOptions: { waitUntil: "networkidle0" },
        screenshotOptions: { type: "webp", quality: 80 },
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `browser-rendering screenshot failed (${response.status}): ${await response.text()}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
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
    // Resolve the switch against the artifact owner's context including their
    // per-user Lab overrides, so a user can opt in without a code change.
    const featureCtx = await get(
      userFeatureSwitchContext(args.orgId ?? "", args.userId),
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.ArtifactPreviewImage, featureCtx)) {
      return false;
    }

    const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
    if (!token) {
      return false;
    }

    const image = await renderArtifactScreenshot(token, args.url, signal);
    signal.throwIfAborted();

    const filename = previewImageFilename(args.deploymentId);
    const key = buildArtifactKey(args.userId, args.id, filename);
    await get(
      putS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        key,
        image,
        PREVIEW_IMAGE_CONTENT_TYPE,
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
      set(renderAndStoreArtifactPreview$, args, new AbortController().signal),
    );
  },
);

/**
 * Backfill / retry sweep: render previews for HTML/website artifacts that still
 * have none (never rendered, or the deploy-time trigger failed / was cut off).
 * Best-effort per artifact — a failure leaves the row's `previewImageUrl` NULL
 * so it retries next sweep and the frontend falls back to the live iframe.
 * No-op when the browser-rendering token is unset. Returns the count generated.
 */
export const generateArtifactPreviews$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
    if (!token) {
      return 0;
    }

    const db = set(writeDb$);
    let generated = 0;
    let cursor: PreviewCandidateCursor | undefined;
    let pages = 0;
    const ownerFeatureEnabled = new Map<string, boolean>();

    while (generated < PREVIEW_BATCH_SIZE && pages < PREVIEW_SCAN_MAX_PAGES) {
      const rows = await db
        .select({
          id: runUploadedFiles.id,
          runId: runUploadedFiles.runId,
          userId: runUploadedFiles.userId,
          orgId: runUploadedFiles.orgId,
          url: runUploadedFiles.url,
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
      pages++;

      for (const row of rows) {
        cursor = { createdAt: row.createdAt, id: row.id };
        if (!row.url) {
          continue;
        }

        const featureKey = `${row.orgId ?? ""}:${row.userId}`;
        let enabled = ownerFeatureEnabled.get(featureKey);
        if (enabled === undefined) {
          enabled = await isArtifactPreviewEnabledForOwner(db, {
            orgId: row.orgId,
            userId: row.userId,
          });
          ownerFeatureEnabled.set(featureKey, enabled);
          signal.throwIfAborted();
        }
        if (!enabled) {
          continue;
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
