import { command } from "ccstate";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { eq } from "drizzle-orm";
import { runUploadedFiles } from "@vm0/db/schema/run-uploaded-file";
import { z } from "zod";

import { env } from "../../lib/env";
import { buildArtifactKey, buildFileUrl } from "../../lib/file-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { putS3Object } from "../external/s3";
import { tapError } from "../utils";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";

const log = logger("artifacts:preview");

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
const PREVIEW_IMAGE_BASENAME = "preview-v2";
const PREVIEW_WAF_COOKIE_NAME = "vm0_artifact_preview";

const browserSnapshotSchema = z.object({
  meta: z.object({
    status: z.number().optional(),
    title: z.string().optional(),
  }),
  success: z.literal(true),
  result: z.object({
    content: z.string().min(1),
    screenshot: z.string().min(1),
  }),
});

// Videos are immutable, so a fixed poster key (no versioning) is fine. The
// Cloudflare Media Transformations frame endpoint only outputs jpg/png.
const VIDEO_POSTER_FILENAME = "poster.jpg";
const VIDEO_POSTER_CONTENT_TYPE = "image/jpeg";

export interface RenderArtifactPreviewArgs {
  // The run_uploaded_files row id; also namespaces the R2 object key.
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly url: string;
  // Discriminates the renderer: `video/*` extracts a poster frame, otherwise a
  // Browser Rendering page screenshot.
  readonly contentType: string | null;
  // Versions the preview key so each deployment gets a fresh, CDN-cache-busting
  // URL instead of overwriting a stale object at a fixed key.
  readonly deploymentId?: string;
}

// Version the preview object by renderer and deployment so both renderer
// upgrades and site redeploys produce a fresh CDN URL.
function previewImageFilename(deploymentId?: string): string {
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

function isCloudflareChallenge(content: string, title?: string): boolean {
  const page = `${title ?? ""}\n${content}`.toLowerCase();
  const hasChallengeCopy = [
    "performing security verification",
    "incompatible browser extension or network configuration",
    "verify you are human",
    "checking your browser",
    "just a moment",
  ].some((marker) => {
    return page.includes(marker);
  });
  const hasChallengeImplementation = [
    "challenges.cloudflare.com",
    "/cdn-cgi/challenge-platform/",
    "challenge-platform",
    "cf-chl-",
    "__cf_chl_",
  ].some((marker) => {
    return page.includes(marker);
  });
  return hasChallengeCopy && hasChallengeImplementation;
}

async function renderArtifactSnapshot(
  token: string,
  wafSecret: string,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const previewUrl = new URL(url);
  const hostDomain = env("ZERO_HOST_DOMAIN");
  if (
    previewUrl.protocol !== "https:" ||
    !previewUrl.hostname.endsWith(`.${hostDomain}`)
  ) {
    throw new Error(
      `artifact preview URL must be a subdomain of ${hostDomain}`,
    );
  }

  const accountId = env("R2_ACCOUNT_ID");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/snapshot?cacheTTL=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        cookies: [
          {
            name: PREVIEW_WAF_COOKIE_NAME,
            value: wafSecret,
            url: previewUrl.origin,
            httpOnly: true,
            secure: true,
            sameSite: "Strict",
          },
        ],
        formats: ["content", "screenshot"],
        viewport: PREVIEW_VIEWPORT,
        gotoOptions: { waitUntil: "networkidle0" },
        screenshotOptions: { type: "webp", quality: 80 },
      }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(
      `browser-rendering snapshot failed (${response.status}): ${await response.text()}`,
    );
  }

  const responseBody: unknown = await response.json();
  const snapshot = browserSnapshotSchema.parse(responseBody);
  if (snapshot.meta.status !== undefined && snapshot.meta.status >= 400) {
    throw new Error(
      `browser-rendering snapshot returned page status ${snapshot.meta.status}`,
    );
  }
  if (isCloudflareChallenge(snapshot.result.content, snapshot.meta.title)) {
    throw new Error(
      "browser-rendering snapshot returned a Cloudflare challenge",
    );
  }
  return Buffer.from(snapshot.result.screenshot, "base64");
}

/**
 * Render a static preview image for a single hosted-site/HTML artifact row,
 * upload it to the user-artifacts R2 bucket next to the artifact, and persist
 * the CDN URL on the row. Returns false (no-op) when the browser-rendering
 * token is unset. Keyed by the row id so it always targets the exact artifact
 * of that run.
 */
const renderAndStoreArtifactPreview$ = command(
  async (
    { get, set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const isVideo = isVideoContentType(args.contentType);
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

    await set(syncArtifactCatalogForFile$, args.id, signal);
    await publishArtifactsChangedForRun(db, args.runId, signal);
    return true;
  },
);

/**
 * Fire-and-forget the creation-time preview render on a detached signal via
 * waitUntil, so it runs to completion after the response returns rather than
 * being cancelled with the request. No-op when there is nothing to render.
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

export interface VideoArtifactPreviewRenderArgs extends RenderArtifactPreviewArgs {
  readonly orgId: string;
}

const renderVideoArtifactPreviewIfEnabled$ = command(
  async (
    { get, set },
    args: VideoArtifactPreviewRenderArgs,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.VideoArtifactPosters, {
        orgId: args.orgId,
        userId: args.userId,
        overrides,
      })
    ) {
      return false;
    }
    return await set(renderAndStoreArtifactPreview$, args, signal);
  },
);

/**
 * Fire-and-forget a video poster render when the owner's feature switch is
 * enabled. The switch lookup stays in the detached task so Artifact creation
 * never waits on poster eligibility or rendering.
 */
export const scheduleVideoArtifactPreviewRender$ = command(
  ({ set }, args: VideoArtifactPreviewRenderArgs | null): void => {
    if (!args) {
      return;
    }
    waitUntil(
      tapError(
        set(
          renderVideoArtifactPreviewIfEnabled$,
          args,
          new AbortController().signal,
        ),
        (error) => {
          log.warn("Failed to render video artifact preview", {
            artifactId: args.id,
            url: args.url,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      ),
    );
  },
);
