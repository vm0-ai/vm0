import {
  artifactSharePolicySchema,
  type ArtifactSharePolicy,
} from "@okouai/api-contracts/contracts/artifact-shares";

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
  readonly PRIVATE_ARTIFACTS_BUCKET?: R2Bucket;
  readonly HOST_DOMAIN: string;
  readonly OKOU_HOST_DOMAIN: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

type PublicBrand = "vm0" | "okou";

interface ActiveSitePointer {
  readonly version: 1;
  readonly publicBrand?: PublicBrand;
  readonly publicSlug: string;
  readonly siteId: string;
  readonly deploymentId: string;
  readonly deploymentVersion?: number;
  readonly artifactUrl?: string;
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
  readonly access?: "owner-private-v1";
  readonly publicBrand?: PublicBrand;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly createdAt: string;
  readonly spaFallback: boolean;
  readonly files: Record<string, ManifestFile>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
} as const;
const STATIC_ALLOWED_ORIGINS = new Set([
  "https://okou.ai",
  "https://app.vm7.ai:8443",
]);
const DEFAULT_ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const IMMUTABLE_DEPLOYMENT_HOST_PATTERN =
  /^dpl-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;

function isSubdomainOf(hostname: string, domain: string): boolean {
  return hostname.endsWith(`.${domain}`) && hostname.length > domain.length + 1;
}

function allowedCorsOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  const normalizedOrigin = url.origin;
  if (STATIC_ALLOWED_ORIGINS.has(normalizedOrigin)) {
    return normalizedOrigin;
  }

  const hostname = url.hostname.toLowerCase();
  if (
    isSubdomainOf(hostname, "okou.ai") ||
    isSubdomainOf(hostname, "vm6.ai") ||
    isSubdomainOf(hostname, "omby.ai")
  ) {
    return normalizedOrigin;
  }
  if (isSubdomainOf(hostname, "vm7.ai") && url.port === "8443") {
    return normalizedOrigin;
  }
  return null;
}

function appendVaryOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Origin");
    return;
  }
  const values = current.split(",").map((value) => {
    return value.trim().toLowerCase();
  });
  if (!values.includes("origin")) {
    headers.set("Vary", `${current}, Origin`);
  }
}

function setCorsHeaders(headers: Headers, request: Request): void {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    headers.set(name, value);
  }
  const origin = allowedCorsOrigin(request.headers.get("Origin"));
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  appendVaryOrigin(headers);
}

function corsResponse(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  setCorsHeaders(headers, request);
  headers.set("X-Robots-Tag", "noindex");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function optionsResponse(request: Request): Response {
  const headers = new Headers();
  setCorsHeaders(headers, request);
  return new Response(null, { headers, status: 204 });
}

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "public, max-age=60" },
  });
}

function defaultRobotsResponse(request: Request): Response {
  return new Response(request.method === "HEAD" ? null : DEFAULT_ROBOTS_TXT, {
    status: 200,
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function pointerNamespace(publicBrand: PublicBrand): string {
  // Keep VM0 on its legacy keys. Okou uses a separate discovery namespace so
  // rolling back to a brand-unaware Worker cannot expose Okou content on VM0.
  return publicBrand === "okou" ? "sites/brands/okou" : "sites";
}

function activePointerKey(
  publicBrand: PublicBrand,
  publicSlug: string,
): string {
  return `${pointerNamespace(publicBrand)}/${publicSlug}/active.json`;
}

function immutableDeploymentPointerKey(
  publicBrand: PublicBrand,
  deploymentId: string,
): string {
  return `${pointerNamespace(publicBrand)}/deployments/${deploymentId}.json`;
}

function siteSlugFromHost(hostname: string, hostDomain: string): string | null {
  const suffix = `.${hostDomain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) {
    return null;
  }
  const slug = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) {
    return null;
  }
  return slug;
}

interface HostedSiteRequestTarget {
  readonly publicSlug: string;
  readonly publicBrands: readonly PublicBrand[];
}

function hostedSiteRequestTarget(
  hostname: string,
  env: Env,
): HostedSiteRequestTarget | null {
  const normalizedHostname = hostname.toLowerCase();
  const candidates = [
    { publicBrand: "vm0", hostDomain: env.HOST_DOMAIN },
    { publicBrand: "okou", hostDomain: env.OKOU_HOST_DOMAIN },
  ] as const;
  const matches = candidates.flatMap(({ publicBrand, hostDomain }) => {
    const publicSlug = siteSlugFromHost(normalizedHostname, hostDomain);
    return publicSlug ? [{ publicBrand, publicSlug }] : [];
  });
  const publicSlug = matches[0]?.publicSlug;
  if (
    !publicSlug ||
    matches.some((match) => {
      return match.publicSlug !== publicSlug;
    })
  ) {
    return null;
  }
  return {
    publicSlug,
    publicBrands: matches.map((match) => {
      return match.publicBrand;
    }),
  };
}

function storedPublicBrand(
  value: ActiveSitePointer | HostedSiteManifest,
): PublicBrand {
  // Persisted hosted-site R2 pointers and manifests have no drain window.
  // Brandless objects are historical VM0 content until #27750 backfills every
  // retained object and verifies that this compatibility read can be removed.
  return value.publicBrand ?? "vm0";
}

interface ResolvedPointer {
  readonly publicBrand: PublicBrand;
  readonly pointer: ActiveSitePointer;
}

async function resolvePointerForBrand(
  bucket: R2Bucket,
  publicBrand: PublicBrand,
  publicSlug: string,
  deploymentId: string | undefined,
): Promise<ResolvedPointer | null> {
  let pointer = deploymentId
    ? await readJson<ActiveSitePointer>(
        bucket,
        immutableDeploymentPointerKey(publicBrand, deploymentId),
      )
    : null;
  if (
    pointer &&
    (pointer.deploymentId !== deploymentId ||
      storedPublicBrand(pointer) !== publicBrand)
  ) {
    return null;
  }
  if (!pointer) {
    pointer = await readJson<ActiveSitePointer>(
      bucket,
      activePointerKey(publicBrand, publicSlug),
    );
    if (
      !pointer ||
      pointer.publicSlug !== publicSlug ||
      storedPublicBrand(pointer) !== publicBrand
    ) {
      return null;
    }
  }
  return { publicBrand, pointer };
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
  pointer: Pick<ActiveSitePointer, "spaFallback">,
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

async function serveHostedSite(
  request: Request,
  env: Env,
  execution: ExecutionContext,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  }

  const url = new URL(request.url);
  const target = hostedSiteRequestTarget(url.hostname, env);
  if (!target) {
    return notFoundResponse();
  }

  const pathname = normalizeRequestPath(url.pathname);
  if (!pathname) {
    return new Response("Bad path", { status: 400 });
  }

  const shared = /^sh-([a-f0-9]{32})-([a-f0-9]{24})$/u.exec(target.publicSlug);
  if (shared?.[1] && shared[2]) {
    const result = await serveSharedArtifact(
      request,
      env,
      target.publicBrands,
      pathname,
      shared[1],
      shared[2],
      execution,
    );
    if (result) return result;
  }

  const previewToken = /^p[vs]-([a-f0-9]{48})$/u.exec(target.publicSlug)?.[1];
  if (previewToken) {
    const preview = await servePrivatePreview(
      request,
      env,
      target,
      pathname,
      previewToken,
    );
    if (preview) {
      return preview;
    }
  }

  const deploymentId = IMMUTABLE_DEPLOYMENT_HOST_PATTERN.exec(
    target.publicSlug,
  )?.[1];
  const pointers = (
    await Promise.all(
      target.publicBrands.map((publicBrand) => {
        return resolvePointerForBrand(
          env.HOSTED_SITES_BUCKET,
          publicBrand,
          target.publicSlug,
          deploymentId,
        );
      }),
    )
  ).filter((pointer): pointer is ResolvedPointer => {
    return pointer !== null;
  });
  if (pointers.length !== 1) {
    return notFoundResponse();
  }
  const { pointer, publicBrand } = pointers[0]!;
  const manifest = await readJson<HostedSiteManifest>(
    env.HOSTED_SITES_BUCKET,
    pointer.manifestKey,
  );
  if (
    !manifest ||
    manifest.access !== undefined ||
    pointer.prefix.startsWith("private-sites/") ||
    manifest.deploymentId !== pointer.deploymentId ||
    storedPublicBrand(manifest) !== publicBrand
  ) {
    return notFoundResponse();
  }

  return serveManifestFile(request, env, pathname, pointer, manifest);
}

async function serveManifestFile(
  request: Request,
  env: Env,
  pathname: string,
  pointer: Pick<ActiveSitePointer, "prefix" | "spaFallback">,
  manifest: HostedSiteManifest,
): Promise<Response> {
  if (pathname === "/robots.txt" && !manifest.files["/robots.txt"]) {
    return defaultRobotsResponse(request);
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

interface PrivatePreviewGrant {
  readonly snapshotId?: string;
  readonly version: 1;
  readonly publicBrand: PublicBrand;
  readonly deploymentId: string;
  readonly expiresAt: string;
}

function privateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  // Generated code receives only its own short-lived origin, never app cookies.
  // Prevent service workers from bypassing the network authorization expiry.
  headers.set(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-downloads; worker-src 'none'",
  );
  return new Response(response.body, { status: response.status, headers });
}

function privatePreviewPrefix(
  deploymentId: string,
  snapshotId: string | undefined,
  publicBrand: PublicBrand,
  shared: boolean,
): string | null {
  if (!shared)
    return snapshotId === undefined
      ? `private-sites/${publicBrand}/${deploymentId}`
      : null;
  if (
    !snapshotId ||
    !IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(`dpl-${snapshotId}`)
  )
    return null;
  return `shared-artifacts/${publicBrand}/${snapshotId}/${deploymentId}`;
}

async function servePrivatePreview(
  request: Request,
  env: Env,
  target: HostedSiteRequestTarget,
  pathname: string,
  token: string,
): Promise<Response | null> {
  const shared = target.publicSlug.startsWith("ps-");
  const grants = (
    await Promise.all(
      target.publicBrands.map(async (publicBrand) => {
        const object = await env.HOSTED_SITES_BUCKET.get(
          `${shared ? "shared-previews" : "private-previews"}/${publicBrand}/${token}.json`,
        );
        if (!object) {
          return null;
        }
        const text = await new Response(object.body).text();
        let grant: Partial<PrivatePreviewGrant> | null;
        try {
          grant = JSON.parse(text) as Partial<PrivatePreviewGrant> | null;
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error;
          }
          grant = null;
        }
        return { grant, publicBrand };
      }),
    )
  ).filter((entry) => {
    return entry !== null;
  });
  // Keep any historical public alias with this shape reachable. No private
  // manifest is ever served by the legacy public-pointer path below.
  if (grants.length === 0) {
    return null;
  }
  const entry = grants[0];
  if (grants.length !== 1 || !entry) {
    return privateResponse(notFoundResponse());
  }
  const { grant, publicBrand } = entry;
  if (
    !grant ||
    typeof grant !== "object" ||
    typeof grant.expiresAt !== "string"
  ) {
    return privateResponse(notFoundResponse());
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    grant.version !== 1 ||
    grant.publicBrand !== publicBrand ||
    typeof grant.deploymentId !== "string" ||
    !IMMUTABLE_DEPLOYMENT_HOST_PATTERN.test(`dpl-${grant.deploymentId}`) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    return privateResponse(notFoundResponse());
  }
  const prefix = privatePreviewPrefix(
    grant.deploymentId,
    grant.snapshotId,
    publicBrand,
    shared,
  );
  if (!prefix) return privateResponse(notFoundResponse());
  const manifest = await readJson<HostedSiteManifest>(
    env.HOSTED_SITES_BUCKET,
    `${prefix}/manifest.json`,
  );
  if (
    !manifest ||
    manifest.access !== "owner-private-v1" ||
    manifest.deploymentId !== grant.deploymentId ||
    manifest.publicBrand !== publicBrand
  ) {
    return privateResponse(notFoundResponse());
  }
  // Authorize every request before reading content; no shared content cache.
  const response = await serveManifestFile(
    request,
    env,
    pathname,
    { prefix, spaFallback: manifest.spaFallback },
    manifest,
  );
  if (expiresAt <= Date.now()) {
    return privateResponse(notFoundResponse());
  }
  return privateResponse(response);
}

async function readPublicShare(
  env: Env,
  brands: readonly PublicBrand[],
  id: string,
  token: string,
): Promise<ArtifactSharePolicy | Response | null> {
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const records: ArtifactSharePolicy[] = [];
  try {
    for (const brand of brands) {
      const object = await env.HOSTED_SITES_BUCKET.get(
        `artifact-shares/${brand}/${id}.json`,
      );
      if (!object) continue;
      const parsed = artifactSharePolicySchema.safeParse(
        await new Response(object.body).json(),
      );
      if (
        !parsed.success ||
        parsed.data.shareId !== id ||
        parsed.data.publicBrand !== brand
      )
        return denied();
      records.push(parsed.data);
    }
  } catch {
    // Unavailable authorization state never falls through to cached bytes.
    return new Response("Artifact unavailable", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  // Preserve historical aliases with a coincidentally matching hostname.
  if (records.length === 0) return null;
  const policy = records[0];
  if (
    records.length !== 1 ||
    !policy ||
    policy.status !== "active" ||
    policy.audience !== "public" ||
    policy.publicToken !== token
  )
    return denied();
  return policy;
}

/** Authorization is deliberately uncached and precedes every content-cache hit. */
async function serveSharedArtifact(
  request: Request,
  env: Env,
  brands: readonly PublicBrand[],
  pathname: string,
  compactId: string,
  token: string,
  execution: ExecutionContext,
): Promise<Response | null> {
  const id = `${compactId.slice(0, 8)}-${compactId.slice(8, 12)}-${compactId.slice(12, 16)}-${compactId.slice(16, 20)}-${compactId.slice(20)}`;
  const denied = () => {
    return privateResponse(notFoundResponse());
  };
  const policy = await readPublicShare(env, brands, id, token);
  if (!policy || policy instanceof Response) return policy;
  const target = policy.target;
  if (target.kind === "file" && pathname !== "/") return denied();
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = `/__artifact-content/${policy.publicBrand}/${target.kind === "html" ? target.snapshotId : encodeURIComponent(target.key)}${pathname}`;
  cacheUrl.search = `?html=${acceptsHtml(request)}`;
  const key = new Request(cacheUrl);
  // Cache only bytes on this Worker's own host. Browser/CDN caches outside
  // this Worker must re-enter authorization; public responses are no-store.
  const cache = (caches as CacheStorage & { readonly default: Cache }).default;
  const cached = await cache.match(key);
  if (cached)
    return privateResponse(
      new Response(request.method === "HEAD" ? null : cached.body, cached),
    );
  let response: Response;
  if (target.kind === "html") {
    response = await serveManifestFile(
      request,
      env,
      pathname,
      {
        prefix: `shared-artifacts/${policy.publicBrand}/${target.snapshotId}/${target.id}`,
        spaFallback: target.manifest.spaFallback,
      },
      target.manifest,
    );
  } else {
    if (!env.PRIVATE_ARTIFACTS_BUCKET) return denied();
    const object = await env.PRIVATE_ARTIFACTS_BUCKET.get(target.key);
    if (!object) return denied();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("Content-Type", target.contentType);
    headers.set("ETag", object.httpEtag);
    headers.set("X-Content-Type-Options", "nosniff");
    // Active uploaded formats execute only as downloads; hosted HTML uses the
    // isolated bundle path with its sandbox and disabled service workers.
    if (/html|svg|xml/iu.test(target.contentType)) {
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(target.filename)}`,
      );
    }
    response = new Response(request.method === "HEAD" ? null : object.body, {
      headers,
    });
  }
  if (request.method === "GET" && response.status === 200) {
    const stored = response.clone();
    stored.headers.set("Cache-Control", "public, max-age=86400");
    execution.waitUntil(cache.put(key, stored));
  }
  return privateResponse(response);
}

export default {
  fetch(
    request: Request,
    env: Env,
    execution: ExecutionContext,
  ): Promise<Response> {
    if (request.method === "OPTIONS") {
      return Promise.resolve(optionsResponse(request));
    }
    return serveHostedSite(request, env, execution).then((response) => {
      return corsResponse(response, request);
    });
  },
};
