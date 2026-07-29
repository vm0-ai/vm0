import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import type { ApiErrorKey } from "@vm0/api-contracts/contracts/errors";
import { usageEvent } from "@vm0/db/schema/usage-event";
import { z } from "zod";

import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { safeJsonParse, safeUrlParse, tapError } from "../utils";
import { loadConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  connectorCredentialRuntimeValueRef,
  loadConnectorCredentialConnection,
  loadConnectorCredentialValues,
  refreshConnectorCredentialAccess,
  type ConnectorCredentialConnection,
} from "./connector-credential-runtime.service";
import { processOrgUsageEvents$ } from "./zero-credit-usage.service";

const X_CONNECTOR_SLUG = "x";
const X_ACCESS_TOKEN_ENVIRONMENT_NAME = "X_TOKEN";
const X_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_X_ACCESS_TOKEN_EXPIRES_IN_MS = 2 * 60 * 60 * 1000;
const DEFAULT_X_CAPTION = "Made with Zero";
const MAX_X_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_X_IMAGE_SIZE_LABEL = "5 MB";
const ARTIFACTS_PATH_PREFIX = "/artifacts/";
const CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX = "/cdn-cgi/image/";
const X_SHARE_USAGE_KIND = "connector";
const X_SHARE_USAGE_PROVIDER = "x";
const X_SHARE_USAGE_CATEGORY = "content.create";

const REQUIRED_X_SCOPES = ["tweet.write", "media.write"] as const;

const X_SUPPORTED_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
] as const;

interface XShareSuccess {
  readonly ok: true;
  readonly tweetId: string;
  readonly tweetUrl: string;
}

interface XShareFailure {
  readonly ok: false;
  readonly errorKey: ApiErrorKey;
  readonly message: string;
}

type XShareResult = XShareSuccess | XShareFailure;

type XAccessTokenResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
    }
  | XShareFailure;

const xMediaUploadResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string().optional(),
        media_id: z.string().optional(),
        media_id_string: z.string().optional(),
      })
      .passthrough()
      .optional(),
    media_id: z.string().optional(),
    media_id_string: z.string().optional(),
  })
  .passthrough();

const xCreateTweetResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

function xShareError(errorKey: ApiErrorKey, message: string): XShareFailure {
  return { ok: false, errorKey, message };
}

function missingRequiredScopes(scopes: readonly string[]): readonly string[] {
  const scopeSet = new Set(scopes);
  return REQUIRED_X_SCOPES.filter((scope) => {
    return !scopeSet.has(scope);
  });
}

async function resolveXAccessToken(args: {
  readonly connector: ConnectorCredentialConnection;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly writeDb: Db;
}): Promise<XAccessTokenResult> {
  const accessTokenValueRef = connectorCredentialRuntimeValueRef(
    args.connector,
    X_ACCESS_TOKEN_ENVIRONMENT_NAME,
  );
  if (accessTokenValueRef === null) {
    return xShareError("CONFLICT", "Reconnect X to post images");
  }
  const values = await loadConnectorCredentialValues({
    connection: args.connector,
    db: args.db,
    valueRefs: [accessTokenValueRef],
  });
  args.signal.throwIfAborted();

  const tokenExpiresAtMs = args.connector.tokenExpiresAt?.getTime() ?? 0;
  const accessToken = values.get(accessTokenValueRef);
  const accessTokenCurrent =
    accessToken &&
    (tokenExpiresAtMs === 0 ||
      tokenExpiresAtMs > now() + X_TOKEN_REFRESH_SKEW_MS);
  if (accessTokenCurrent) {
    return { ok: true, accessToken };
  }

  const refreshed = await refreshConnectorCredentialAccess({
    connection: args.connector,
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    runtimeEnvironmentName: X_ACCESS_TOKEN_ENVIRONMENT_NAME,
    signal: args.signal,
    persist: {
      db: args.writeDb,
      defaultExpiresInMs: DEFAULT_X_ACCESS_TOKEN_EXPIRES_IN_MS,
    },
  });
  if (refreshed.kind === "configuration-unavailable") {
    return xShareError("PROVIDER_UNAVAILABLE", "X sharing is not configured");
  }
  return refreshed.kind === "ok"
    ? { ok: true, accessToken: refreshed.accessToken }
    : xShareError("CONFLICT", "Reconnect X to post images");
}

function normalizeImageContentType(contentTypeHeader: string | null): string {
  return contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function xImageMediaType(contentType: string): string | null {
  return (X_SUPPORTED_IMAGE_CONTENT_TYPES as readonly string[]).includes(
    contentType,
  )
    ? contentType
    : null;
}

function artifactPathFromShareImageUrl(pathname: string): string | null {
  if (pathname.startsWith(ARTIFACTS_PATH_PREFIX)) {
    return pathname;
  }

  if (!pathname.startsWith(CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX)) {
    return null;
  }

  const transformedPath = pathname.slice(
    CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX.length,
  );
  const artifactPathStart = transformedPath.indexOf(ARTIFACTS_PATH_PREFIX);
  if (artifactPathStart === -1) {
    return null;
  }

  return transformedPath.slice(artifactPathStart);
}

function isAllowedShareImageUrl(parsed: URL): boolean {
  const publicArtifactsBaseUrl = new URL(env("PUBLIC_ARTIFACTS_BASE_URL"));
  if (parsed.origin !== publicArtifactsBaseUrl.origin) {
    return false;
  }

  return artifactPathFromShareImageUrl(parsed.pathname) !== null;
}

async function readXImageBytes(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | XShareFailure> {
  if (!response.body) {
    return xShareError("BAD_REQUEST", "Couldn't load the image");
  }

  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    totalLength += chunk.byteLength;
    if (totalLength > MAX_X_IMAGE_SIZE_BYTES) {
      return xShareError(
        "BAD_REQUEST",
        `X supports images up to ${MAX_X_IMAGE_SIZE_LABEL}`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchShareImage(args: {
  readonly imageUrl: string;
  readonly signal: AbortSignal;
}): Promise<
  | {
      readonly ok: true;
      readonly media: string;
      readonly mediaType: string;
    }
  | XShareFailure
> {
  const parsed = safeUrlParse(args.imageUrl);
  if (!parsed) {
    return xShareError("BAD_REQUEST", "Choose an image with a public URL");
  }

  if (!isAllowedShareImageUrl(parsed)) {
    return xShareError("BAD_REQUEST", "Choose an image with a public URL");
  }

  const response = await tapError(fetch(parsed, { signal: args.signal }));
  args.signal.throwIfAborted();
  if (!response) {
    return xShareError("BAD_REQUEST", "Couldn't load the image");
  }

  if (!response.ok) {
    return xShareError("BAD_REQUEST", "Couldn't load the image");
  }

  const contentType = normalizeImageContentType(
    response.headers.get("content-type"),
  );
  const mediaType = xImageMediaType(contentType);
  if (!mediaType) {
    return xShareError(
      "BAD_REQUEST",
      "X supports JPEG, PNG, WebP, BMP, and TIFF images",
    );
  }

  const imageBytes = await readXImageBytes(response, args.signal);
  args.signal.throwIfAborted();
  if (!(imageBytes instanceof Uint8Array)) {
    return imageBytes;
  }
  const media = Buffer.from(imageBytes).toString("base64");
  if (!media) {
    return xShareError("BAD_REQUEST", "Couldn't load the image");
  }

  return { ok: true, media, mediaType };
}

function extractMediaId(value: z.infer<typeof xMediaUploadResponseSchema>) {
  return (
    value.data?.id ??
    value.data?.media_id_string ??
    value.data?.media_id ??
    value.media_id_string ??
    value.media_id ??
    null
  );
}

async function xApiJson(args: {
  readonly accessToken: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly url: string;
}) {
  const response = await fetch(args.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`X API returned ${response.status}`);
  }

  const body = safeJsonParse(responseText);
  if (body === undefined) {
    throw new Error("X API returned invalid JSON");
  }
  return body;
}

async function uploadXImageMedia(args: {
  readonly accessToken: string;
  readonly image: {
    readonly media: string;
    readonly mediaType: string;
  };
  readonly signal: AbortSignal;
}): Promise<string> {
  const body = await xApiJson({
    accessToken: args.accessToken,
    signal: args.signal,
    url: "https://api.x.com/2/media/upload",
    body: {
      media: args.image.media,
      media_category: "tweet_image",
      media_type: args.image.mediaType,
      shared: false,
    },
  });
  const parsed = xMediaUploadResponseSchema.parse(body);
  const mediaId = extractMediaId(parsed);
  if (!mediaId) {
    throw new Error("X media upload did not return an id");
  }
  return mediaId;
}

async function createXPost(args: {
  readonly accessToken: string;
  readonly caption: string | undefined;
  readonly mediaId: string;
  readonly signal: AbortSignal;
}): Promise<string> {
  const text = args.caption?.trim() || DEFAULT_X_CAPTION;
  const body = await xApiJson({
    accessToken: args.accessToken,
    signal: args.signal,
    url: "https://api.x.com/2/tweets",
    body: {
      text,
      media: { media_ids: [args.mediaId] },
    },
  });
  return xCreateTweetResponseSchema.parse(body).data.id;
}

async function recordXPostUsage(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly writeDb: Db;
}): Promise<void> {
  await args.writeDb.insert(usageEvent).values({
    idempotencyKey: randomUUID(),
    orgId: args.orgId,
    userId: args.userId,
    kind: X_SHARE_USAGE_KIND,
    provider: X_SHARE_USAGE_PROVIDER,
    category: X_SHARE_USAGE_CATEGORY,
    quantity: 1,
  });
}

export const shareImageToX$ = command(
  async (
    { get, set },
    args: {
      readonly caption: string | undefined;
      readonly imageUrl: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<XShareResult> => {
    const db = get(db$);
    const writeDb = set(writeDb$);
    const snapshot = await loadConnectorRuntimeSnapshot(db);
    signal.throwIfAborted();
    const loaded = await loadConnectorCredentialConnection({
      db,
      snapshot,
      orgId: args.orgId,
      userId: args.userId,
      connectorSlug: X_CONNECTOR_SLUG,
    });
    signal.throwIfAborted();

    if (loaded.kind === "missing") {
      return xShareError("NOT_FOUND", "Connect X to post images");
    }
    if (loaded.kind === "unavailable" || loaded.connection.needsReconnect) {
      return xShareError("CONFLICT", "Reconnect X to post images");
    }
    const connector = loaded.connection;
    const missingScopes = missingRequiredScopes(connector.oauthScopes ?? []);
    if (missingScopes.length > 0) {
      return xShareError("CONFLICT", "Reconnect X to post images");
    }

    const accessTokenResult = await resolveXAccessToken({
      connector,
      db,
      orgId: args.orgId,
      userId: args.userId,
      signal,
      writeDb,
    });
    if (!accessTokenResult.ok) {
      return accessTokenResult;
    }

    const image = await fetchShareImage({
      imageUrl: args.imageUrl,
      signal,
    });
    if (!image.ok) {
      return image;
    }

    const postResult = await tapError(
      (async () => {
        const mediaId = await uploadXImageMedia({
          accessToken: accessTokenResult.accessToken,
          image,
          signal,
        });
        const tweetId = await createXPost({
          accessToken: accessTokenResult.accessToken,
          caption: args.caption,
          mediaId,
          signal,
        });
        return {
          ok: true as const,
          tweetId,
          tweetUrl: `https://x.com/i/web/status/${tweetId}`,
        };
      })(),
    );
    signal.throwIfAborted();
    if (!postResult) {
      return xShareError(
        "PROVIDER_UNAVAILABLE",
        "X couldn't publish the post, try again",
      );
    }

    await recordXPostUsage({
      orgId: args.orgId,
      userId: args.userId,
      writeDb,
    });
    signal.throwIfAborted();
    await set(processOrgUsageEvents$, args.orgId, signal);
    signal.throwIfAborted();

    return postResult;
  },
);
