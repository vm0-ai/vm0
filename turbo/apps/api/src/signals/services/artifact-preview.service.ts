import { command } from "ccstate";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ArtifactPreviewStatus } from "@okouai/api-contracts/contracts/artifact-catalog";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { ArtifactPreviewError } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { z } from "zod";

import { env } from "../../lib/env";
import { publicArtifactsBaseUrlForBrand } from "../../lib/file-url";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { putImmutableS3Object } from "../external/s3";
import {
  readBoundedResponseText,
  safeJsonParse,
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
const VIDEO_POSTER_CONTENT_TYPE = "image/jpeg";
const CLOUDFLARE_MEDIA_MAX_INPUT_BYTES = 100_000_000;
const CLOUDFLARE_MEDIA_MAX_DURATION_SECONDS = 10 * 60;
const ARTIFACT_PREVIEW_MAX_ATTEMPTS = 3;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 4 * 1024;

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

function unsupportedVideoPreview(
  args: RenderArtifactPreviewArgs,
): UnsupportedVideoPreview | null {
  const contentType = normalizedContentType(args.contentType);
  if (contentType !== "video/mp4") {
    return {
      status: "unsupported",
      error: {
        code: "unsupported_video_container",
        message:
          "Cloudflare Media Transformations does not support this video container.",
        retryable: false,
        source: "preflight",
      },
    };
  }
  if (
    args.sizeBytes !== null &&
    args.sizeBytes !== undefined &&
    args.sizeBytes >= CLOUDFLARE_MEDIA_MAX_INPUT_BYTES
  ) {
    return {
      status: "unsupported",
      error: {
        code: "video_too_large",
        message:
          "The video exceeds Cloudflare Media Transformations' 100 MB input limit.",
        retryable: false,
        source: "preflight",
      },
    };
  }
  if (
    args.durationSeconds !== null &&
    args.durationSeconds !== undefined &&
    args.durationSeconds > CLOUDFLARE_MEDIA_MAX_DURATION_SECONDS
  ) {
    return {
      status: "unsupported",
      error: {
        code: "video_too_long",
        message:
          "The video exceeds Cloudflare Media Transformations' 10 minute duration limit.",
        retryable: false,
        source: "preflight",
      },
    };
  }
  return null;
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
          or(
            isNull(runUploadedFiles.previewStatus),
            eq(runUploadedFiles.previewStatus, "transient_failure"),
            and(
              eq(runUploadedFiles.previewStatus, "pending"),
              or(
                isNull(runUploadedFiles.previewUpdatedAt),
                sql`${runUploadedFiles.previewUpdatedAt} < now() - interval '5 minutes'`,
              ),
            ),
          ),
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

/** Render, store, and publish a preview for one claimed attempt. */
const renderAndStoreArtifactPreview$ = command(
  async (
    { get, set },
    args: ClaimedArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const isVideo = isVideoContentType(args.contentType);
    let image: Buffer;
    let filename: string;
    let contentType: string;
    if (isVideo) {
      image = await extractVideoPoster(args.url, args.publicBrand, signal);
      filename = VIDEO_POSTER_FILENAME;
      contentType = VIDEO_POSTER_CONTENT_TYPE;
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
      image = await renderArtifactSnapshot(token, wafSecret, args.url, signal);
      filename = previewImageFilename(args.deploymentId);
      contentType = PREVIEW_IMAGE_CONTENT_TYPE;
    }
    signal.throwIfAborted();

    const artifact = await set(
      allocateArtifactObject$,
      {
        userId: args.userId,
        id: args.id,
        filename,
        variant: filename,
        publicBrand: args.publicBrand,
      },
      signal,
    );
    await get(
      putImmutableS3Object(
        env("R2_USER_ARTIFACTS_BUCKET_NAME"),
        artifact.key,
        image,
        contentType,
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
  },
);

const runArtifactPreview$ = command(
  async (
    { set },
    args: RenderArtifactPreviewArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    if (isVideoContentType(args.contentType)) {
      const unsupported = unsupportedVideoPreview(args);
      if (unsupported) {
        await set(
          persistArtifactPreviewFailure$,
          { id: args.id, ...unsupported },
          signal,
        );
        log.debug("Artifact preview outcome", {
          event: "artifact_preview_outcome",
          artifactId: args.id,
          contentType: args.contentType,
          producer: args.producer,
          outcome: unsupported.status,
          reason: unsupported.error.code,
          retryable: false,
          attemptCount: 0,
        });
        return;
      }
    } else if (!env("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN")) {
      return;
    }

    const attemptCount = await set(claimArtifactPreviewAttempt$, args, signal);
    if (attemptCount === null) {
      return;
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
        attemptCount,
      });
      return;
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
