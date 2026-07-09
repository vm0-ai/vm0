import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ApiErrorKey } from "@vm0/api-contracts/contracts/errors";
import { refreshXToken } from "@vm0/connectors/auth-providers/connectors/x/oauth";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";

const X_CONNECTOR_TYPE = "x";
const X_ACCESS_TOKEN_SECRET_NAME = "X_ACCESS_TOKEN";
const X_REFRESH_TOKEN_SECRET_NAME = "X_REFRESH_TOKEN";
const X_TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_X_ACCESS_TOKEN_EXPIRES_IN_MS = 2 * 60 * 60 * 1000;
const DEFAULT_X_CAPTION = "Made with Zero";
const ARTIFACTS_PATH_PREFIX = "/artifacts/";
const CLOUDFLARE_IMAGE_RESIZE_PATH_PREFIX = "/cdn-cgi/image/";

const REQUIRED_X_SCOPES = ["tweet.write", "media.write"] as const;

const X_SUPPORTED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

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

interface XConnectorRow {
  readonly oauthScopes: string | null;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

type XAccessTokenResult =
  | {
      readonly ok: true;
      readonly accessToken: string;
    }
  | XShareFailure;

interface XSecretValues {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}

const oauthScopesSchema = z.array(z.string());

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

function parseOAuthScopes(value: string | null): readonly string[] {
  if (!value) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return [];
  }
  const parsed = oauthScopesSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function missingRequiredScopes(scopes: readonly string[]): readonly string[] {
  const scopeSet = new Set(scopes);
  return REQUIRED_X_SCOPES.filter((scope) => {
    return !scopeSet.has(scope);
  });
}

async function readXConnectorRow(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<XConnectorRow | null> {
  const [row] = await args.db
    .select({
      oauthScopes: connectors.oauthScopes,
      needsReconnect: connectors.needsReconnect,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        eq(connectors.type, X_CONNECTOR_TYPE),
      ),
    );
  return row ?? null;
}

async function loadXSecretValues(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<XSecretValues> {
  const rows = await args.db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, args.orgId),
        eq(secrets.userId, args.userId),
        eq(secrets.type, "connector"),
        inArray(secrets.name, [
          X_ACCESS_TOKEN_SECRET_NAME,
          X_REFRESH_TOKEN_SECRET_NAME,
        ]),
      ),
    );

  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(row.name, await decryptStoredSecretValue(row.encryptedValue));
  }

  return {
    accessToken: values.get(X_ACCESS_TOKEN_SECRET_NAME) ?? null,
    refreshToken: values.get(X_REFRESH_TOKEN_SECRET_NAME) ?? null,
  };
}

async function upsertConnectorSecret(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  const encryptedValue = await encryptStoredSecretValue(args.value);
  await args.db
    .insert(secrets)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue,
      description: null,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      set: {
        encryptedValue,
        description: null,
        updatedAt: sql`clock_timestamp()`,
      },
    });
}

async function refreshAndPersistXAccessToken(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
  readonly writeDb: Db;
}): Promise<XAccessTokenResult> {
  const clientId = optionalEnv("X_OAUTH_CLIENT_ID");
  const clientSecret = optionalEnv("X_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return xShareError("PROVIDER_UNAVAILABLE", "X sharing is not configured");
  }

  let refreshed: Awaited<ReturnType<typeof refreshXToken>>;
  try {
    refreshed = await refreshXToken(
      clientId,
      clientSecret,
      args.refreshToken,
      args.signal,
    );
  } catch {
    return xShareError("CONFLICT", "Reconnect X to post images");
  }

  const nextRefreshToken = refreshed.refreshToken ?? args.refreshToken;
  const tokenExpiresAt = new Date(
    Date.now() +
      (refreshed.expiresIn
        ? refreshed.expiresIn * 1000
        : DEFAULT_X_ACCESS_TOKEN_EXPIRES_IN_MS),
  );

  await args.writeDb.transaction(async (tx) => {
    await lockConnectorState(tx, {
      orgId: args.orgId,
      userId: args.userId,
      type: X_CONNECTOR_TYPE,
    });
    args.signal.throwIfAborted();

    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: X_ACCESS_TOKEN_SECRET_NAME,
      value: refreshed.accessToken,
    });
    args.signal.throwIfAborted();

    await upsertConnectorSecret({
      db: tx,
      orgId: args.orgId,
      userId: args.userId,
      name: X_REFRESH_TOKEN_SECRET_NAME,
      value: nextRefreshToken,
    });
    args.signal.throwIfAborted();

    await tx
      .update(connectors)
      .set({
        tokenExpiresAt,
        needsReconnect: false,
        reconnectReason: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          eq(connectors.type, X_CONNECTOR_TYPE),
        ),
      );
  });

  return { ok: true, accessToken: refreshed.accessToken };
}

async function resolveXAccessToken(args: {
  readonly connector: XConnectorRow;
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly writeDb: Db;
}): Promise<XAccessTokenResult> {
  const secretValues = await loadXSecretValues({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
  });
  args.signal.throwIfAborted();

  const tokenExpiresAtMs = args.connector.tokenExpiresAt?.getTime() ?? 0;
  const accessTokenCurrent =
    secretValues.accessToken &&
    (tokenExpiresAtMs === 0 ||
      tokenExpiresAtMs > Date.now() + X_TOKEN_REFRESH_SKEW_MS);
  if (accessTokenCurrent) {
    return { ok: true, accessToken: secretValues.accessToken };
  }

  if (!secretValues.refreshToken) {
    return xShareError("CONFLICT", "Reconnect X to post images");
  }

  return await refreshAndPersistXAccessToken({
    orgId: args.orgId,
    userId: args.userId,
    refreshToken: secretValues.refreshToken,
    signal: args.signal,
    writeDb: args.writeDb,
  });
}

function normalizeImageContentType(contentTypeHeader: string | null): string {
  return contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function xImageMediaType(contentType: string): string | null {
  return X_SUPPORTED_IMAGE_CONTENT_TYPES.has(contentType) ? contentType : null;
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
  let parsed: URL;
  try {
    parsed = new URL(args.imageUrl);
  } catch {
    return xShareError("BAD_REQUEST", "Choose an image with a public URL");
  }

  if (!isAllowedShareImageUrl(parsed)) {
    return xShareError("BAD_REQUEST", "Choose an image with a public URL");
  }

  let response: Response;
  try {
    response = await fetch(parsed, { signal: args.signal });
  } catch {
    return xShareError("BAD_REQUEST", "Couldn't load the image");
  }
  args.signal.throwIfAborted();

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

  const media = Buffer.from(await response.arrayBuffer()).toString("base64");
  args.signal.throwIfAborted();
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

  const body = await response.json().catch(() => {
    return null;
  });
  if (!response.ok) {
    throw new Error(`X API returned ${response.status}`);
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
    const connector = await readXConnectorRow({
      db,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    if (!connector) {
      return xShareError("NOT_FOUND", "Connect X to post images");
    }
    if (connector.needsReconnect) {
      return xShareError("CONFLICT", "Reconnect X to post images");
    }
    const missingScopes = missingRequiredScopes(
      parseOAuthScopes(connector.oauthScopes),
    );
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

    try {
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
        ok: true,
        tweetId,
        tweetUrl: `https://x.com/i/web/status/${tweetId}`,
      };
    } catch {
      return xShareError(
        "PROVIDER_UNAVAILABLE",
        "X couldn't publish the post, try again",
      );
    }
  },
);
