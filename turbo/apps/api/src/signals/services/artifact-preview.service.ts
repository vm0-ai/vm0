import { command } from "ccstate";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { ArtifactPreviewStatus } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ArtifactPreviewError } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { z } from "zod";

import { env } from "../../lib/env";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { publicArtifactsBaseUrlForBrand } from "../../lib/file-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { putImmutableS3Object } from "../external/s3";
import {
  readBoundedResponseText,
  safeJsonParse,
  safeUrlParse,
  settle,
  tapError,
} from "../utils";
import { allocateArtifactObject$ } from "./artifact-storage.service";
import { syncArtifactCatalogForFile$ } from "./artifact-catalog.service";
import { publishArtifactsChangedForRun } from "./artifact-realtime.service";

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
const PREVIEW_IMAGE_BASENAME = "preview-v3";
const PREVIEW_WAF_COOKIE_NAME = "vm0_artifact_preview";
const SNAPSHOT_ACTION_TIMEOUT_MS = 30_000;
const PRIMARY_NAVIGATION_OPTIONS = {
  gotoOptions: { waitUntil: "networkidle2", timeout: 20_000 },
} as const;
const NAVIGATION_TIMEOUT_RETRY_OPTIONS = {
  gotoOptions: { waitUntil: "domcontentloaded", timeout: 15_000 },
  waitForSelector: {
    selector: "body > *",
    visible: true,
    timeout: 10_000,
  },
} as const;

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

const browserSnapshotErrorSchema = z.object({
  errors: z.array(
    z.object({
      code: z.number(),
      detail: z.string().optional(),
    }),
  ),
});

// Poster versions are write-once. Renderer changes must use a new filename
// instead of replacing bytes behind an immutable CDN URL. The Cloudflare Media
// Transformations frame endpoint only outputs jpg/png.
const VIDEO_POSTER_FILENAME = "poster-v2.jpg";
const BROWSER_VIDEO_POSTER_FILENAME = "poster-v3.jpg";
const VIDEO_POSTER_CONTENT_TYPE = "image/jpeg";
const CLOUDFLARE_MEDIA_MAX_INPUT_BYTES = 100_000_000;
const CLOUDFLARE_MEDIA_MAX_DURATION_SECONDS = 10 * 60;
const ARTIFACT_PREVIEW_MAX_ATTEMPTS = 3;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 4 * 1024;
const BROWSER_VIDEO_RENDER_TIMEOUT_MS = 15_000;
const BROWSER_VIDEO_REQUEST_TIMEOUT_MS = 20_000;
const ARTIFACT_PREVIEW_BACKFILL_BATCH_SIZE = 4;

const VIDEO_PREVIEW_FALLBACK_ERROR_CODES = [
  "unsupported_video_container",
  "video_too_large",
  "video_too_long",
  "cloudflare_media_9412",
] as const;

type VideoPreviewRenderer = "cloudflare-media" | "cloudflare-browser";
type ArtifactPreviewRenderer = VideoPreviewRenderer | "cloudflare-browser-page";

export interface ArtifactPreviewBackfillResult {
  readonly selected: number;
  readonly claimed: number;
  readonly ready: number;
  readonly permanentFailure: number;
  readonly transientFailure: number;
  readonly skipped: number;
}

export interface RenderArtifactPreviewArgs {
  // The run_uploaded_files row id; also namespaces the R2 object key.
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly url: string;
  // Discriminates the renderer: `video/*` extracts a poster frame, otherwise a
  // Browser Rendering page screenshot.
  readonly contentType: string | null;
  readonly sizeBytes?: number | null;
  readonly durationSeconds?: number | null;
  // A bounded, non-user-identifying producer label for outcome telemetry.
  readonly producer: string;
  readonly publicBrand: PublicBrand;
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

type ArtifactPreviewFailureStatus = Extract<
  ArtifactPreviewStatus,
  "unsupported" | "permanent_failure" | "transient_failure"
>;

interface UnsupportedVideoPreview {
  readonly status: "unsupported";
  readonly error: ArtifactPreviewError;
}

type VideoPreviewPlan =
  | { readonly renderer: VideoPreviewRenderer }
  | { readonly unsupported: UnsupportedVideoPreview };

class PreviewRenderFailure extends Error {
  readonly previewError: ArtifactPreviewError;

  constructor(previewError: ArtifactPreviewError) {
    super(previewError.message);
    this.name = "PreviewRenderFailure";
    this.previewError = previewError;
  }
}

function normalizedContentType(contentType: string | null): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function videoPreviewPlan(args: RenderArtifactPreviewArgs): VideoPreviewPlan {
  const contentType = normalizedContentType(args.contentType);
  if (contentType !== "video/mp4" && contentType !== "video/webm") {
    return {
      unsupported: {
        status: "unsupported",
        error: {
          code: "unsupported_video_container",
          message:
            "No artifact preview renderer supports this video container.",
          retryable: false,
          source: "preflight",
        },
      },
    };
  }
  if (contentType === "video/webm") {
    return { renderer: "cloudflare-browser" };
  }
  if (
    args.sizeBytes !== null &&
    args.sizeBytes !== undefined &&
    args.sizeBytes >= CLOUDFLARE_MEDIA_MAX_INPUT_BYTES
  ) {
    return { renderer: "cloudflare-browser" };
  }
  if (
    args.durationSeconds !== null &&
    args.durationSeconds !== undefined &&
    args.durationSeconds > CLOUDFLARE_MEDIA_MAX_DURATION_SECONDS
  ) {
    return { renderer: "cloudflare-browser" };
  }
  return { renderer: "cloudflare-media" };
}

function isRetryableProviderStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function cloudflareMediaFailure(
  response: Response,
): Promise<PreviewRenderFailure> {
  const body = await readBoundedResponseText(
    response,
    PROVIDER_ERROR_RESPONSE_MAX_BYTES,
  );
  const providerCode =
    body.kind === "text"
      ? /MEDIA_TRANSFORMATION_ERROR\s+(\d+)/u.exec(body.text)?.[1]
      : undefined;
  const retryable =
    providerCode === "9412"
      ? false
      : providerCode === "9523" || isRetryableProviderStatus(response.status);
  return new PreviewRenderFailure({
    code: providerCode
      ? `cloudflare_media_${providerCode}`
      : `cloudflare_media_http_${response.status}`,
    message:
      providerCode === "9412"
        ? "Cloudflare could not parse the artifact as a supported video."
        : retryable
          ? "Cloudflare media frame extraction failed temporarily."
          : "Cloudflare media frame extraction rejected the artifact.",
    retryable,
    source: "cloudflare-media",
    ...(providerCode ? { providerCode } : {}),
  });
}

async function cloudflareBrowserFailure(
  response: Response,
): Promise<PreviewRenderFailure> {
  await readBoundedResponseText(response, PROVIDER_ERROR_RESPONSE_MAX_BYTES);
  const retryable = isRetryableProviderStatus(response.status);
  return new PreviewRenderFailure({
    code: `cloudflare_browser_http_${response.status}`,
    message: retryable
      ? "Cloudflare browser rendering failed temporarily."
      : "Cloudflare browser rendering rejected the preview request.",
    retryable,
    source: "cloudflare-browser",
  });
}

function previewErrorFrom(error: unknown): ArtifactPreviewError {
  if (error instanceof PreviewRenderFailure) {
    return error.previewError;
  }
  return {
    code: "preview_render_failed",
    message: "The preview renderer failed before producing an image.",
    retryable: true,
    source: "preview-service",
  };
}

// Extract a poster frame from a video via Cloudflare Media Transformations.
// This is a public transform URL on the artifacts CDN (no auth), the video
// sibling of the `/cdn-cgi/image/` resizing already used for images.
async function extractVideoPoster(
  videoUrl: string,
  publicBrand: PublicBrand,
  signal: AbortSignal,
): Promise<Buffer> {
  const base = publicArtifactsBaseUrlForBrand(publicBrand);
  const transformUrl = `${base}/cdn-cgi/media/mode=frame,time=1s,width=640,format=jpg/${videoUrl}`;
  const response = await fetch(transformUrl, { signal });
  if (!response.ok) {
    const failure = await cloudflareMediaFailure(response);
    throw failure;
  }
  return Buffer.from(await response.arrayBuffer());
}

const BROWSER_VIDEO_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; background: #000; overflow: hidden; }
      #preview { width: 100%; height: 100%; object-fit: contain; background: #000; }
    </style>
  </head>
  <body>
    <video id="preview" muted playsinline preload="auto" data-preview-state="pending"></video>
  </body>
</html>`;

function publicArtifactVideoUrl(url: string, publicBrand: PublicBrand): string {
  const artifactUrl = safeUrlParse(url);
  const artifactBaseUrl = safeUrlParse(
    `${publicArtifactsBaseUrlForBrand(publicBrand)}/`,
  );
  if (
    !artifactUrl ||
    !artifactBaseUrl ||
    artifactUrl.protocol !== "https:" ||
    artifactUrl.origin !== artifactBaseUrl.origin ||
    artifactUrl.username !== "" ||
    artifactUrl.password !== "" ||
    artifactUrl.search !== "" ||
    artifactUrl.hash !== "" ||
    !artifactUrl.pathname.startsWith("/artifacts/")
  ) {
    throw new PreviewRenderFailure({
      code: "invalid_video_preview_url",
      message: "The video preview URL is outside the public artifact origin.",
      retryable: false,
      source: "preflight",
    });
  }
  return artifactUrl.href;
}

function browserVideoScript(videoUrl: string): string {
  const serializedUrl = JSON.stringify(videoUrl)
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll(">", String.raw`\u003e`)
    .replaceAll("&", String.raw`\u0026`);
  return `(() => {
    const video = document.querySelector("#preview");
    const settle = (state) => {
      if (!(video instanceof HTMLVideoElement) || video.classList.contains("frame-settled")) return;
      video.dataset.previewState = state;
      video.classList.add("frame-settled");
    };
    if (!(video instanceof HTMLVideoElement)) return;
    video.addEventListener("error", () => settle("media-error-" + String(video.error?.code ?? "unknown")), { once: true });
    video.addEventListener("loadeddata", () => {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) {
        settle("no-video-track");
        return;
      }
      const painted = () => requestAnimationFrame(() => requestAnimationFrame(() => settle("ready")));
      const duration = video.duration;
      if (Number.isFinite(duration) && duration > 0.1) {
        const target = Math.min(1, Math.max(0, duration - 0.05));
        if (target > 0.01) {
          video.addEventListener("seeked", painted, { once: true });
          try {
            video.currentTime = target;
            return;
          } catch {
            painted();
            return;
          }
        }
      }
      painted();
    }, { once: true });
    video.src = ${serializedUrl};
    video.load();
  })();`;
}

function browserVideoState(content: string): string | undefined {
  return /data-preview-state="([^"]+)"/u.exec(content)?.[1];
}

function browserVideoRenderFailure(state: string | undefined): never {
  const permanent =
    state === "no-video-track" ||
    state === "media-error-3" ||
    state === "media-error-4";
  throw new PreviewRenderFailure({
    code:
      state === "no-video-track"
        ? "browser_video_no_visual_track"
        : state?.startsWith("media-error-")
          ? `browser_video_${state}`
          : "browser_video_not_ready",
    message:
      state === "no-video-track"
        ? "The artifact contains no decodable visual video track."
        : permanent
          ? "Chromium could not decode a visual frame from the artifact."
          : "Chromium did not produce a video frame before the render deadline.",
    retryable: !permanent,
    source: "cloudflare-browser",
  });
}

async function extractVideoPosterWithBrowser(
  token: string,
  videoUrl: string,
  publicBrand: PublicBrand,
  signal: AbortSignal,
): Promise<Buffer> {
  const validatedUrl = publicArtifactVideoUrl(videoUrl, publicBrand);
  const accountId = env("R2_ACCOUNT_ID");
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(BROWSER_VIDEO_REQUEST_TIMEOUT_MS),
  ]);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/snapshot?cacheTTL=0`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        html: BROWSER_VIDEO_HTML,
        addScriptTag: [{ content: browserVideoScript(validatedUrl) }],
        allowResourceTypes: ["media"],
        formats: ["content", "screenshot"],
        viewport: { width: 640, height: 400 },
        actionTimeout: BROWSER_VIDEO_RENDER_TIMEOUT_MS,
        gotoOptions: {
          waitUntil: "domcontentloaded",
          timeout: BROWSER_VIDEO_RENDER_TIMEOUT_MS,
        },
        waitForSelector: {
          selector: ".frame-settled",
          visible: true,
          timeout: BROWSER_VIDEO_RENDER_TIMEOUT_MS,
        },
        screenshotOptions: { type: "jpeg", quality: 80 },
      }),
      signal: requestSignal,
    },
  );
  if (!response.ok) {
    const failure = await cloudflareBrowserFailure(response);
    throw failure;
  }

  const responseBody: unknown = await response.json();
  const snapshot = browserSnapshotSchema.parse(responseBody);
  const state = browserVideoState(snapshot.result.content);
  if (state !== "ready") {
    browserVideoRenderFailure(state);
  }
  return Buffer.from(snapshot.result.screenshot, "base64");
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

function isNavigationTimeoutResponse(
  status: number,
  responseBody: string,
): boolean {
  if (status !== 422) {
    return false;
  }
  const parsed = browserSnapshotErrorSchema.safeParse(
    safeJsonParse(responseBody),
  );
  return (
    parsed.success &&
    parsed.data.errors.some((error) => {
      return (
        error.code === 6002 &&
        error.detail?.startsWith("Navigation timeout") === true
      );
    })
  );
}

type SnapshotNavigationOptions =
  | typeof PRIMARY_NAVIGATION_OPTIONS
  | typeof NAVIGATION_TIMEOUT_RETRY_OPTIONS;

interface FetchArtifactSnapshotArgs {
  readonly token: string;
  readonly wafSecret: string;
  readonly url: string;
  readonly previewUrl: URL;
  readonly navigationOptions: SnapshotNavigationOptions;
}

function fetchArtifactSnapshot(
  {
    token,
    wafSecret,
    url,
    previewUrl,
    navigationOptions,
  }: FetchArtifactSnapshotArgs,
  signal: AbortSignal,
): Promise<Response> {
  const accountId = env("R2_ACCOUNT_ID");
  return fetch(
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
        ...navigationOptions,
        actionTimeout: SNAPSHOT_ACTION_TIMEOUT_MS,
        screenshotOptions: { type: "webp", quality: 80 },
      }),
      signal,
    },
  );
}

async function renderArtifactSnapshot(
  token: string,
  wafSecret: string,
  url: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const previewUrl = new URL(url);
  const hostDomains = [env("ZERO_HOST_DOMAIN"), env("OKOU_PUBLIC_HOST_DOMAIN")];
  if (
    previewUrl.protocol !== "https:" ||
    !hostDomains.some((hostDomain) => {
      return previewUrl.hostname.endsWith(`.${hostDomain}`);
    })
  ) {
    throw new Error("artifact preview URL must use a hosted-site domain");
  }

  let response = await fetchArtifactSnapshot(
    {
      token,
      wafSecret,
      url,
      previewUrl,
      navigationOptions: PRIMARY_NAVIGATION_OPTIONS,
    },
    signal,
  );
  if (!response.ok) {
    const responseBody = await response.text();
    // Keep the extra Browser Rendering request exclusive to navigation: action
    // and request-stage timeouts need different fixes and should not double cost.
    if (!isNavigationTimeoutResponse(response.status, responseBody)) {
      throw new Error(
        `browser-rendering snapshot failed (${response.status}): ${responseBody}`,
      );
    }
    response = await fetchArtifactSnapshot(
      {
        token,
        wafSecret,
        url,
        previewUrl,
        navigationOptions: NAVIGATION_TIMEOUT_RETRY_OPTIONS,
      },
      signal,
    );
  }
  if (!response.ok) {
    const failure = await cloudflareBrowserFailure(response);
    throw failure;
  }

  const responseBody: unknown = await response.json();
  const snapshot = browserSnapshotSchema.parse(responseBody);
  if (snapshot.meta.status !== undefined && snapshot.meta.status >= 400) {
    throw new PreviewRenderFailure({
      code: `artifact_page_http_${snapshot.meta.status}`,
      message: "The hosted artifact returned an error while rendering.",
      retryable: isRetryableProviderStatus(snapshot.meta.status),
      source: "cloudflare-browser",
    });
  }
  if (isCloudflareChallenge(snapshot.result.content, snapshot.meta.title)) {
    throw new PreviewRenderFailure({
      code: "cloudflare_browser_challenge",
      message: "Cloudflare browser rendering returned a challenge page.",
      retryable: true,
      source: "cloudflare-browser",
    });
  }
  return Buffer.from(snapshot.result.screenshot, "base64");
}

interface ClaimedArtifactPreviewArgs extends RenderArtifactPreviewArgs {
  readonly attemptCount: number;
}

function claimableArtifactPreviewState() {
  return or(
    isNull(runUploadedFiles.previewStatus),
    eq(runUploadedFiles.previewStatus, "transient_failure"),
    and(
      inArray(runUploadedFiles.previewStatus, [
        "unsupported",
        "permanent_failure",
      ]),
      inArray(
        sql`${runUploadedFiles.previewError}->>'code'`.mapWith(pgTextDecoder),
        VIDEO_PREVIEW_FALLBACK_ERROR_CODES,
      ),
    ),
    and(
      eq(runUploadedFiles.previewStatus, "pending"),
      or(
        isNull(runUploadedFiles.previewUpdatedAt),
        sql`${runUploadedFiles.previewUpdatedAt} < now() - interval '5 minutes'`,
      ),
    ),
  );
}

const claimArtifactPreviewAttempt$ = command(
  async (
    { set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<number | null> => {
    const db = set(writeDb$);
    const attemptedAt = nowDate();
    const [claimed] = await db
      .update(runUploadedFiles)
      .set({
        previewStatus: "pending",
        previewError: null,
        previewAttemptCount: sql`${runUploadedFiles.previewAttemptCount} + 1`,
        previewUpdatedAt: attemptedAt,
        updatedAt: attemptedAt,
      })
      .where(
        and(
          eq(runUploadedFiles.id, args.id),
          isNull(runUploadedFiles.previewImageUrl),
          lt(
            runUploadedFiles.previewAttemptCount,
            ARTIFACT_PREVIEW_MAX_ATTEMPTS,
          ),
          claimableArtifactPreviewState(),
        ),
      )
      .returning({ attemptCount: runUploadedFiles.previewAttemptCount });
    signal.throwIfAborted();
    return claimed?.attemptCount ?? null;
  },
);

const persistArtifactPreviewFailure$ = command(
  async (
    { set },
    args: {
      readonly id: string;
      readonly status: ArtifactPreviewFailureStatus;
      readonly error: ArtifactPreviewError;
      readonly attemptCount?: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const failedAt = nowDate();
    const db = set(writeDb$);
    await db
      .update(runUploadedFiles)
      .set({
        previewStatus: args.status,
        previewError: args.error,
        previewUpdatedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        args.attemptCount === undefined
          ? and(
              eq(runUploadedFiles.id, args.id),
              isNull(runUploadedFiles.previewImageUrl),
            )
          : and(
              eq(runUploadedFiles.id, args.id),
              isNull(runUploadedFiles.previewImageUrl),
              eq(runUploadedFiles.previewStatus, "pending"),
              eq(runUploadedFiles.previewAttemptCount, args.attemptCount),
            ),
      );
    signal.throwIfAborted();
  },
);

interface RenderedArtifactPreview {
  readonly image: Buffer;
  readonly filename: string;
  readonly contentType: string;
  readonly renderer: ArtifactPreviewRenderer;
}

async function renderVideoPreview(
  args: RenderArtifactPreviewArgs,
  signal: AbortSignal,
): Promise<RenderedArtifactPreview> {
  const plan = videoPreviewPlan(args);
  if ("unsupported" in plan) {
    throw new PreviewRenderFailure(plan.unsupported.error);
  }
  const browserToken = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
  if (plan.renderer === "cloudflare-browser") {
    if (!browserToken) {
      throw new PreviewRenderFailure({
        code: "browser_renderer_unconfigured",
        message: "Cloudflare browser rendering is not configured.",
        retryable: true,
        source: "preview-service",
      });
    }
    return {
      image: await extractVideoPosterWithBrowser(
        browserToken,
        args.url,
        args.publicBrand,
        signal,
      ),
      filename: BROWSER_VIDEO_POSTER_FILENAME,
      contentType: VIDEO_POSTER_CONTENT_TYPE,
      renderer: "cloudflare-browser",
    };
  }

  const validatedUrl = publicArtifactVideoUrl(args.url, args.publicBrand);
  const mediaResult = await settle(
    extractVideoPoster(validatedUrl, args.publicBrand, signal),
    signal,
  );
  if (mediaResult.ok) {
    return {
      image: mediaResult.value,
      filename: VIDEO_POSTER_FILENAME,
      contentType: VIDEO_POSTER_CONTENT_TYPE,
      renderer: "cloudflare-media",
    };
  }
  const error = mediaResult.error;
  if (
    !(error instanceof PreviewRenderFailure) ||
    error.previewError.code !== "cloudflare_media_9412" ||
    !browserToken
  ) {
    throw error;
  }
  return {
    image: await extractVideoPosterWithBrowser(
      browserToken,
      validatedUrl,
      args.publicBrand,
      signal,
    ),
    filename: BROWSER_VIDEO_POSTER_FILENAME,
    contentType: VIDEO_POSTER_CONTENT_TYPE,
    renderer: "cloudflare-browser",
  };
}

/** Render, store, and publish a preview for one claimed attempt. */
const renderAndStoreArtifactPreview$ = command(
  async (
    { get, set },
    args: ClaimedArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<ArtifactPreviewRenderer> => {
    const isVideo = isVideoContentType(args.contentType);
    let rendered: RenderedArtifactPreview;
    if (isVideo) {
      rendered = await renderVideoPreview(args, signal);
    } else {
      const token = env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
      if (!token) {
        throw new PreviewRenderFailure({
          code: "browser_renderer_unconfigured",
          message: "Cloudflare browser rendering is not configured.",
          retryable: true,
          source: "preview-service",
        });
      }
      const wafSecret = env("ARTIFACT_PREVIEW_WAF_SECRET");
      if (!wafSecret) {
        throw new PreviewRenderFailure({
          code: "browser_renderer_waf_unconfigured",
          message: "Artifact preview WAF access is not configured.",
          retryable: true,
          source: "preview-service",
        });
      }
      rendered = {
        image: await renderArtifactSnapshot(token, wafSecret, args.url, signal),
        filename: previewImageFilename(args.deploymentId),
        contentType: PREVIEW_IMAGE_CONTENT_TYPE,
        renderer: "cloudflare-browser-page",
      };
    }
    signal.throwIfAborted();

    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        id: args.id,
        filename: rendered.filename,
        variant: rendered.filename,
        publicBrand: args.publicBrand,
      },
      signal,
    );
    await get(
      putImmutableS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        artifact.key,
        rendered.image,
        rendered.contentType,
        { signal, metadata: artifact.metadata },
      ),
    );
    signal.throwIfAborted();

    const db = set(writeDb$);
    await db
      .update(runUploadedFiles)
      .set({
        previewImageUrl: artifact.url,
        previewStatus: "ready",
        previewError: null,
        previewUpdatedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(runUploadedFiles.id, args.id),
          isNull(runUploadedFiles.previewImageUrl),
        ),
      );
    signal.throwIfAborted();

    await set(syncArtifactCatalogForFile$, args.id, signal);
    await publishArtifactsChangedForRun(db, args.runId, signal);
    return rendered.renderer;
  },
);

const runArtifactPreview$ = command(
  async (
    { set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<ArtifactPreviewStatus | null> => {
    if (isVideoContentType(args.contentType)) {
      const plan = videoPreviewPlan(args);
      if ("unsupported" in plan) {
        await set(
          persistArtifactPreviewFailure$,
          { id: args.id, ...plan.unsupported },
          signal,
        );
        log.debug("Artifact preview outcome", {
          event: "artifact_preview_outcome",
          artifactId: args.id,
          contentType: args.contentType,
          producer: args.producer,
          outcome: plan.unsupported.status,
          reason: plan.unsupported.error.code,
          retryable: false,
          attemptCount: 0,
        });
        return "unsupported";
      }
      if (
        plan.renderer === "cloudflare-browser" &&
        !env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")
      ) {
        return null;
      }
    } else if (!env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")) {
      return null;
    }

    const attemptCount = await set(claimArtifactPreviewAttempt$, args, signal);
    if (attemptCount === null) {
      return null;
    }

    const result = await settle(
      set(renderAndStoreArtifactPreview$, { ...args, attemptCount }, signal),
      signal,
    );
    if (result.ok) {
      log.debug("Artifact preview outcome", {
        event: "artifact_preview_outcome",
        artifactId: args.id,
        contentType: args.contentType,
        producer: args.producer,
        outcome: "ready",
        renderer: result.value,
        attemptCount,
      });
      return "ready";
    }

    const error = previewErrorFrom(result.error);
    const status: ArtifactPreviewFailureStatus = error.retryable
      ? "transient_failure"
      : "permanent_failure";
    await set(
      persistArtifactPreviewFailure$,
      { id: args.id, status, error, attemptCount },
      signal,
    );
    log.warn("Artifact preview outcome", {
      event: "artifact_preview_outcome",
      artifactId: args.id,
      contentType: args.contentType,
      producer: args.producer,
      outcome: status,
      reason: error.code,
      providerCode: error.providerCode,
      retryable: error.retryable,
      attemptCount,
    });
    return status;
  },
);

function backfillPublicBrand(
  metadata: Record<string, unknown>,
  url: string,
): PublicBrand {
  if (metadata.publicBrand === "okou" || metadata.publicBrand === "vm0") {
    return metadata.publicBrand;
  }
  const parsedUrl = safeUrlParse(url);
  const okouArtifactsUrl = safeUrlParse(
    `${publicArtifactsBaseUrlForBrand("okou")}/`,
  );
  if (parsedUrl?.origin === okouArtifactsUrl?.origin) {
    return "okou";
  }
  return "vm0";
}

function backfillDurationSeconds(
  metadata: Record<string, unknown>,
): number | null {
  const durationSeconds = metadata.durationSeconds;
  return typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 0
    ? durationSeconds
    : null;
}

/**
 * Repair a small, deterministic batch of legacy or retryable video previews.
 * The row-level claim remains the concurrency and idempotency boundary.
 */
export const backfillArtifactPreviews$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<ArtifactPreviewBackfillResult> => {
    const empty: ArtifactPreviewBackfillResult = {
      selected: 0,
      claimed: 0,
      ready: 0,
      permanentFailure: 0,
      transientFailure: 0,
      skipped: 0,
    };
    if (!env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")) {
      return empty;
    }

    const db = set(writeDb$);
    const rows = await db
      .select({
        id: runUploadedFiles.id,
        runId: runUploadedFiles.runId,
        userId: runUploadedFiles.userId,
        orgId: runUploadedFiles.orgId,
        url: runUploadedFiles.url,
        contentType: runUploadedFiles.contentType,
        sizeBytes: runUploadedFiles.sizeBytes,
        metadata: runUploadedFiles.metadata,
        producer: runUploadedFiles.source,
      })
      .from(runUploadedFiles)
      .where(
        and(
          isNull(runUploadedFiles.previewImageUrl),
          isNotNull(runUploadedFiles.runId),
          isNotNull(runUploadedFiles.orgId),
          isNotNull(runUploadedFiles.url),
          inArray(runUploadedFiles.contentType, ["video/mp4", "video/webm"]),
          lt(
            runUploadedFiles.previewAttemptCount,
            ARTIFACT_PREVIEW_MAX_ATTEMPTS,
          ),
          claimableArtifactPreviewState(),
        ),
      )
      .orderBy(runUploadedFiles.createdAt, runUploadedFiles.id)
      .limit(ARTIFACT_PREVIEW_BACKFILL_BATCH_SIZE);
    signal.throwIfAborted();

    const result: {
      selected: number;
      claimed: number;
      ready: number;
      permanentFailure: number;
      transientFailure: number;
      skipped: number;
    } = { ...empty, selected: rows.length };
    for (const row of rows) {
      if (!row.runId || !row.orgId || !row.url) {
        result.skipped += 1;
        continue;
      }
      const publicBrand = backfillPublicBrand(row.metadata, row.url);
      const outcome = await settle(
        set(
          runArtifactPreview$,
          {
            id: row.id,
            runId: row.runId,
            userId: row.userId,
            orgId: row.orgId,
            url: row.url,
            contentType: row.contentType,
            sizeBytes: row.sizeBytes,
            durationSeconds: backfillDurationSeconds(row.metadata),
            producer: row.producer,
            publicBrand,
          },
          signal,
        ),
        signal,
      );
      if (!outcome.ok) {
        result.skipped += 1;
        log.warn("Artifact preview backfill item failed", {
          event: "artifact_preview_backfill_item_error",
          artifactId: row.id,
          contentType: row.contentType,
          producer: row.producer,
          errorClass:
            outcome.error instanceof Error ? outcome.error.name : "unknown",
        });
        continue;
      }
      if (outcome.value === null || outcome.value === "unsupported") {
        result.skipped += 1;
        continue;
      }
      result.claimed += 1;
      if (outcome.value === "ready") {
        result.ready += 1;
      } else if (outcome.value === "permanent_failure") {
        result.permanentFailure += 1;
      } else if (outcome.value === "transient_failure") {
        result.transientFailure += 1;
      }
    }
    log.debug("Artifact preview backfill outcome", {
      event: "artifact_preview_backfill_outcome",
      ...result,
    });
    return result;
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
        set(runArtifactPreview$, args, new AbortController().signal),
        (error) => {
          log.warn("Artifact preview processing failed", {
            event: "artifact_preview_processing_error",
            artifactId: args.id,
            contentType: args.contentType,
            producer: args.producer,
            errorClass: error instanceof Error ? error.name : "unknown",
          });
        },
      ),
    );
  },
);
