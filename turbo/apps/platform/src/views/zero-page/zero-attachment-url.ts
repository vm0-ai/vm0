import { toast } from "@vm0/ui/components/ui/sonner";
import { logger } from "../../signals/log.ts";
import { writeToClipboard } from "../../signals/zero-page/clipboard.ts";

const log = logger("zero-attachment-url");

const LEGACY_FILE_PATH_PATTERN = /^\/f\/([^/]+)\/([^/]+)\/([^/]+)$/;
const ARTIFACT_FILE_PATH_PATTERN = /^\/artifacts\/([^/]+)\/([^/]+)\/([^/]+)$/;
const CLERK_USER_ID_PREFIX = "user_";

export function attachmentFilenameFromUrl(url: string): string {
  const path = url.split("?")[0].split("#")[0];
  const last = path.split("/").pop();
  return last && last.length > 0 ? last : "image";
}

function publicArtifactsBaseUrl(): string | null {
  const baseUrl = import.meta.env.PUBLIC_ARTIFACTS_BASE_URL;
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return null;
  }
  return baseUrl.replace(/\/+$/, "");
}

function hasExplicitUrlOrigin(url: string): boolean {
  return /^[a-z][a-z\d+\-.]*:\/\//i.test(url);
}

function browserOrigin(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.location.origin;
}

type PlatformHostTarget = "api" | "www";

function rewritePlatformHostname(
  hostname: string,
  target: PlatformHostTarget,
): string {
  return hostname.replace(/(^|-)(platform|app|www|api)\./, `$1${target}.`);
}

function addOrigin(origins: Set<string>, baseUrl: string | null) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }
  origins.add(new URL(baseUrl).origin);
}

function addPlatformOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }

  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);

  for (const target of ["api", "www"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function platformFileOrigins(): Set<string> {
  const origins = new Set<string>();
  const configuredApiUrl = import.meta.env.VITE_API_URL as string | undefined;

  addPlatformOriginVariants(origins, browserOrigin());
  addPlatformOriginVariants(origins, configuredApiUrl ?? null);
  addOrigin(origins, publicArtifactsBaseUrl());

  return origins;
}

function isPlatformFileUrlHost(parsed: URL, sourceUrl: string): boolean {
  return (
    !hasExplicitUrlOrigin(sourceUrl) || platformFileOrigins().has(parsed.origin)
  );
}

function storageUserIdSegmentFromFileUrlSegment(userIdSegment: string): string {
  if (
    userIdSegment === "user" ||
    userIdSegment.startsWith(CLERK_USER_ID_PREFIX) ||
    userIdSegment.startsWith("user-")
  ) {
    return userIdSegment;
  }
  return `${CLERK_USER_ID_PREFIX}${userIdSegment}`;
}

function artifactCdnUrl(args: {
  userIdSegment: string;
  idSegment: string;
  filenameSegment: string;
  hash: string;
}): string | null {
  const baseUrl = publicArtifactsBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/artifacts/${args.userIdSegment}/${args.idSegment}/${args.filenameSegment}${args.hash}`;
}

function parseFileUrl(url: string): URL | null {
  const baseUrl = browserOrigin() ?? undefined;
  if (!URL.canParse(url, baseUrl)) {
    return null;
  }
  return new URL(url, baseUrl);
}

function normalizedLegacyFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(LEGACY_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment: storageUserIdSegmentFromFileUrlSegment(userIdSegment),
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

function normalizedArtifactFileUrl(url: string): string | null {
  const parsed = parseFileUrl(url);
  if (!parsed) {
    return null;
  }
  if (!isPlatformFileUrlHost(parsed, url)) {
    return null;
  }
  const match = parsed.pathname.match(ARTIFACT_FILE_PATH_PATTERN);
  if (!match) {
    return null;
  }
  const [, userIdSegment, idSegment, filenameSegment] = match;
  return artifactCdnUrl({
    userIdSegment,
    idSegment,
    filenameSegment,
    hash: parsed.hash,
  });
}

export function publicAttachmentUrl(url: string): string {
  return normalizedLegacyFileUrl(url) ?? normalizedArtifactFileUrl(url) ?? url;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

// Fetch the asset as a blob so downloads are delivered from a same-origin
// object URL. Cross-origin `<a download>` is intentionally avoided because
// browsers ignore it for CDN image URLs and open the asset instead.
async function fetchBlobForDownload(
  url: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const fetchUrl = publicAttachmentUrl(url);
  // The catch branch reports network/CORS failures without falling back to
  // cross-origin anchor navigation, which would open images instead.
  // eslint-disable-next-line no-restricted-syntax -- fetch/CORS failures should surface as download failures
  try {
    const res = await fetch(fetchUrl, {
      cache: "reload",
      mode: "cors",
      signal,
    });
    if (!res.ok) {
      throw new Error(`fetch failed: ${String(res.status)}`);
    }
    return await res.blob();
  } catch (error) {
    signal.throwIfAborted();
    log.warn("downloadUrl: fetch failed", error);
    toast.error("Download failed");
    return null;
  }
}

export async function downloadAttachmentUrl(
  url: string,
  signal: AbortSignal = AbortSignal.any([]),
  filename = attachmentFilenameFromUrl(url),
): Promise<void> {
  const blob = await fetchBlobForDownload(url, signal);
  if (blob !== null) {
    triggerBlobDownload(blob, filename);
  }
}

export async function copyAttachmentLinkToClipboard(
  url: string,
): Promise<void> {
  const copied = await writeToClipboard(publicAttachmentUrl(url));
  if (copied) {
    toast.success("Link copied");
    return;
  }
  toast.error("Failed to copy link");
}
