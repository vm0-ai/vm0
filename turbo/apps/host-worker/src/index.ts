interface R2ObjectBody {
  readonly body: ReadableStream;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

interface Env {
  readonly HOSTED_SITES_BUCKET: R2Bucket;
  readonly HOST_DOMAIN: string;
}

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly prefix: string;
  readonly manifestKey: string;
  readonly spaFallback: boolean;
  readonly updatedAt: string;
}

interface ManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

interface HostedSiteManifest {
  readonly version: 1;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly createdAt: string;
  readonly spaFallback: boolean;
  readonly files: Record<string, ManifestFile>;
}

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

function activePointerKey(publicSlug: string): string {
  return `sites/${publicSlug}/active.json`;
}

function siteSlugFromHost(hostname: string, hostDomain: string): string | null {
  const suffix = `.${hostDomain}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const slug = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) {
    return null;
  }
  return slug;
}

function safeDecodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function normalizeRequestPath(pathname: string): string | null {
  const decoded = safeDecodePath(pathname);
  if (!decoded || !decoded.startsWith("/") || decoded.includes("\0")) {
    return null;
  }
  if (decoded.includes("\\") || decoded.startsWith("//")) {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  if (
    parts.some((part) => {
      return part === "." || part === "..";
    })
  ) {
    return null;
  }
  return `/${parts.join("/")}`;
}

function looksLikeAssetPath(path: string): boolean {
  return /\.[A-Za-z0-9]+$/u.test(path) || path.startsWith("/assets/");
}

function acceptsHtml(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") || accept.includes("*/*");
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  const text = await new Response(object.body).text();
  return JSON.parse(text) as T;
}

function resolveFilePath(
  request: Request,
  pathname: string,
  pointer: ActiveSitePointer,
  manifest: HostedSiteManifest,
): string | null {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  if (manifest.files[requestedPath]) {
    return requestedPath;
  }
  if (
    pointer.spaFallback &&
    acceptsHtml(request) &&
    !looksLikeAssetPath(requestedPath) &&
    manifest.files["/index.html"]
  ) {
    return "/index.html";
  }
  return null;
}

function cacheControl(file: ManifestFile): string {
  if (file.immutable) {
    return "public, max-age=31536000, immutable";
  }
  if (file.path === "/index.html" || file.contentType.startsWith("text/html")) {
    return "public, max-age=0, must-revalidate";
  }
  return "public, max-age=3600";
}

async function serveHostedSite(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const url = new URL(request.url);
  const publicSlug = siteSlugFromHost(url.hostname, env.HOST_DOMAIN);
  if (!publicSlug) {
    return notFoundResponse();
  }

  const pathname = normalizeRequestPath(url.pathname);
  if (!pathname) {
    return new Response("Bad path", { status: 400 });
  }

  const pointer = await readJson<ActiveSitePointer>(
    env.HOSTED_SITES_BUCKET,
    activePointerKey(publicSlug),
  );
  if (!pointer || pointer.publicSlug !== publicSlug) {
    return notFoundResponse();
  }

  const manifest = await readJson<HostedSiteManifest>(
    env.HOSTED_SITES_BUCKET,
    pointer.manifestKey,
  );
  if (!manifest || manifest.deploymentId !== pointer.deploymentId) {
    return notFoundResponse();
  }

  const filePath = resolveFilePath(request, pathname, pointer, manifest);
  if (!filePath) {
    return notFoundResponse();
  }

  const file = manifest.files[filePath];
  if (!file) {
    return notFoundResponse();
  }

  const object = await env.HOSTED_SITES_BUCKET.get(
    `${pointer.prefix}${filePath}`,
  );
  if (!object) {
    return notFoundResponse();
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", file.contentType);
  headers.set("Cache-Control", cacheControl(file));
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers,
  });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return serveHostedSite(request, env);
  },
};
