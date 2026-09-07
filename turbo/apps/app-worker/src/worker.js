import { createClerkClient } from "@clerk/backend";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";

const SHARED_THREAD_PATH =
  /^\/share\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;
const PREVIEW_API_ORIGIN_PATTERN =
  /^https:\/\/(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const APP_ASSET_PATH_PREFIX = "/okou-app/assets/";
const APP_BOOTSTRAP_API_PATH = "/api/bootstrap";
const APP_ASSET_REQUEST_HEADER_NAMES = [
  "Accept",
  "If-Modified-Since",
  "If-None-Match",
  "Range",
];
const PRODUCTION_APP_HOSTNAME = "app.okou.ai";
const VERCEL_PROTECTION_BYPASS = "x-vercel-protection-bypass";
const CLERK_EDGE_SESSION_TIMEOUT_MS = 1000;
const CLERK_EDGE_SESSION_PREVIEW_HOSTNAME_PATTERN =
  /^pr-[1-9][0-9]*-app-okou-app-preview\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/u;
const SECURITY_HEADERS = {
  "Permissions-Policy":
    "camera=(), geolocation=(), payment=(), usb=(), serial=(), display-capture=(self), clipboard-read=(), microphone=(self), bluetooth=(self), clipboard-write=(self), fullscreen=(self)",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
const EMBEDDED_SHELL_CONTENT_TYPES = new Map([
  ["/index.html", "text/html; charset=UTF-8"],
  ["/sw.js", "application/javascript; charset=UTF-8"],
  ["/manifest.webmanifest", "application/manifest+json; charset=UTF-8"],
  ["/robots.txt", "text/plain; charset=UTF-8"],
  ["/icons/icon-192.png", "image/png"],
  ["/icons/icon-512.png", "image/png"],
  ["/icons/icon-512-maskable.png", "image/png"],
]);

const OKOU_APP_METADATA = {
  brandName: "Okou",
  canonicalUrl: "https://app.okou.ai/",
  description:
    "An AI teammate that connects to 3,000+ tools: get the right data, run agentic workflows, and deliver finished work with team-wide context.",
  documentTitle: "AI Teammate for Real Work — More Done, Same Team | Okou",
  openGraphTitle: "AI Teammate for Real Work — More Done, Same Team | Okou",
  socialImagePath: "web/okou-og-image-373c892e.png",
  staticAssetsOrigin: "https://static.okou.io",
  twitterDescription:
    "An AI teammate that connects to 3,000+ tools: get the right data, run agentic workflows, and deliver finished work with team-wide context.",
};

function apiOrigin(requestUrl) {
  const origin = derivePlatformServiceOrigin(requestUrl.origin, "api");
  if (origin === requestUrl.origin) {
    throw new Error("App API origin is unavailable");
  }
  return origin;
}

function setMetaContent(content) {
  return {
    element(element) {
      element.setAttribute("content", content);
    },
  };
}

function setBrandContext(brandName) {
  return {
    element(element) {
      element.setAttribute("data-app-brand-name", brandName);
    },
  };
}

function removeElement() {
  return {
    element(element) {
      element.remove();
    },
  };
}

function staticAssetUrl(metadata, path) {
  return `${metadata.staticAssetsOrigin}/${path.replace(/^\/+/u, "")}`;
}

function previewAppAssetHtml(indexHtml, requestUrl) {
  if (!requestUrl.hostname.toLowerCase().endsWith(".workers.dev")) {
    return indexHtml;
  }

  const previewAssetBase = `${requestUrl.origin}${APP_ASSET_PATH_PREFIX}`;
  return indexHtml.replaceAll(
    `${OKOU_APP_METADATA.staticAssetsOrigin}${APP_ASSET_PATH_PREFIX}`,
    previewAssetBase,
  );
}

function htmlResponse(indexHtml, assetResponse, status, cacheControl) {
  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Content-Type", "text/html; charset=UTF-8");
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(indexHtml, { status, headers });
}

function noIndexResponse(response, cacheControl) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Cache-Control", cacheControl);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function serializeClerkEdgeSession(session) {
  return JSON.stringify(session)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function appBootstrapRequestHeaders(request, requestUrl) {
  const headers = new Headers({
    Accept: "application/json",
    Origin: requestUrl.origin,
  });
  const cookie = request.headers.get("Cookie");
  if (cookie !== null) {
    headers.set("Cookie", cookie);
  }
  const bypass =
    requestUrl.searchParams.get(VERCEL_PROTECTION_BYPASS) ??
    request.headers.get(VERCEL_PROTECTION_BYPASS);
  if (bypass !== null) {
    headers.set(VERCEL_PROTECTION_BYPASS, bypass);
  }
  return headers;
}

function parseAppBootstrap(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.responses)
  ) {
    return null;
  }
  for (const entry of value.responses) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      entry.method !== "GET" ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("/api/") ||
      entry.contentType !== "application/json" ||
      !Object.hasOwn(entry, "body")
    ) {
      return null;
    }
  }
  return value.responses;
}

async function fetchAppBootstrap(request, requestUrl, fetcher) {
  const url = new URL(APP_BOOTSTRAP_API_PATH, apiOrigin(requestUrl));
  url.searchParams.set("path", `${requestUrl.pathname}${requestUrl.search}`);

  let response;
  try {
    response = await fetcher(url, {
      headers: appBootstrapRequestHeaders(request, requestUrl),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return parseAppBootstrap(body);
}

function appBootstrapScript(entry) {
  const path = encodeURIComponent(entry.path);
  return `<script type="application/json" data-okou-api-bootstrap="" data-method="GET" data-path="${path}" data-content-type="application/json">${serializeClerkEdgeSession(entry.body)}</script>`;
}

function clerkEdgeSessionAuthorizedParty(requestUrl, env) {
  if (requestUrl.protocol !== "https:") {
    return null;
  }
  if (requestUrl.hostname === PRODUCTION_APP_HOSTNAME) {
    return requestUrl.origin;
  }
  return CLERK_EDGE_SESSION_PREVIEW_HOSTNAME_PATTERN.test(
    requestUrl.hostname,
  ) && env.CLERK_EDGE_AUTHORIZED_PARTY === requestUrl.origin
    ? requestUrl.origin
    : null;
}

async function clerkEdgeSession(
  request,
  env,
  authorizedParty,
  clerkClientFactory,
) {
  let timeoutId;
  try {
    const publishableKey = env.CLERK_PUBLISHABLE_KEY;
    const secretKey = env.CLERK_SECRET_KEY;
    if (
      typeof publishableKey !== "string" ||
      publishableKey.length === 0 ||
      typeof secretKey !== "string" ||
      secretKey.length === 0
    ) {
      return null;
    }

    const timeout = new Promise((resolve) => {
      timeoutId = globalThis.setTimeout(() => {
        resolve(null);
      }, CLERK_EDGE_SESSION_TIMEOUT_MS);
    });
    const authentication = Promise.resolve().then(() => {
      const clerk = clerkClientFactory({
        publishableKey,
        secretKey,
        telemetry: { disabled: true },
      });
      return clerk.authenticateRequest(request, {
        acceptsToken: "session_token",
        authorizedParties: [authorizedParty],
      });
    });
    const requestState = await Promise.race([authentication, timeout]);
    // App shell session bootstrap must not forward Clerk browser mutations.
    if (
      requestState === null ||
      !requestState.isAuthenticated ||
      requestState.headers.has("Location") ||
      requestState.headers.has("Set-Cookie")
    ) {
      return null;
    }

    const { userId, sessionId } = requestState.toAuth();
    if (
      typeof userId !== "string" ||
      userId.length === 0 ||
      typeof sessionId !== "string" ||
      sessionId.length === 0
    ) {
      return null;
    }
    return { userId, sessionId };
  } catch {
    // Clerk must never affect availability of the existing app shell.
    return null;
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

function rewriteAppPage(
  response,
  edgeSessionPromise,
  request,
  requestUrl,
  bootstrapFetcher,
) {
  const bootstrapState = { available: false };
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(OKOU_APP_METADATA.brandName))
    .on("title", {
      element(element) {
        element.setInnerContent(OKOU_APP_METADATA.documentTitle);
      },
    })
    .on(
      'meta[name="application-name"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on(
      'meta[name="description"]',
      setMetaContent(OKOU_APP_METADATA.description),
    )
    .on('meta[property="og:type"]', setMetaContent("website"))
    .on(
      'meta[property="og:site_name"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on(
      'meta[property="og:title"]',
      setMetaContent(OKOU_APP_METADATA.openGraphTitle),
    )
    .on(
      'meta[property="og:description"]',
      setMetaContent(OKOU_APP_METADATA.description),
    )
    .on(
      'meta[property="og:image"]',
      setMetaContent(
        staticAssetUrl(OKOU_APP_METADATA, OKOU_APP_METADATA.socialImagePath),
      ),
    )
    .on(
      'meta[property="og:image:alt"]',
      setMetaContent(OKOU_APP_METADATA.openGraphTitle),
    )
    .on('meta[name="twitter:card"]', setMetaContent("summary_large_image"))
    .on('meta[name="twitter:site"]', setMetaContent("@okou_ai"))
    .on('meta[name="twitter:creator"]', setMetaContent("@okou_ai"))
    .on(
      'meta[name="twitter:title"]',
      setMetaContent(OKOU_APP_METADATA.openGraphTitle),
    )
    .on(
      'meta[name="twitter:description"]',
      setMetaContent(OKOU_APP_METADATA.twitterDescription),
    )
    .on(
      'meta[name="twitter:image"]',
      setMetaContent(
        staticAssetUrl(OKOU_APP_METADATA, OKOU_APP_METADATA.socialImagePath),
      ),
    )
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex, nofollow" />', {
          html: true,
        });
        element.append(
          `<link rel="canonical" href="${OKOU_APP_METADATA.canonicalUrl}" />`,
          { html: true },
        );
        element.append(
          `<meta property="og:url" content="${OKOU_APP_METADATA.canonicalUrl}" />`,
          { html: true },
        );
      },
    });
  if (edgeSessionPromise !== null) {
    rewriter
      .on("body", {
        async element(element) {
          const edgeSession = await edgeSessionPromise;
          if (edgeSession === null) {
            return;
          }
          const bootstrap = await fetchAppBootstrap(
            request,
            requestUrl,
            bootstrapFetcher,
          );
          if (bootstrap !== null && bootstrap.length > 0) {
            bootstrapState.available = true;
            element.prepend(bootstrap.map(appBootstrapScript).join(""), {
              html: true,
            });
          }
          element.append(
            `<script type="application/json" id="okou-clerk-edge-session">${serializeClerkEdgeSession(edgeSession)}</script>`,
            { html: true },
          );
        },
      })
      .on("#app-bootstrap-skeleton", {
        element(element) {
          if (bootstrapState.available) {
            element.remove();
          }
        },
      });
  }
  const rewrittenResponse = rewriter.transform(response);
  return noIndexResponse(
    rewrittenResponse,
    edgeSessionPromise === null
      ? "public, max-age=0, must-revalidate"
      : "private, no-store",
  );
}

async function rewriteManifest(response) {
  const manifest = await response.json();
  manifest.name = OKOU_APP_METADATA.brandName;
  manifest.short_name = OKOU_APP_METADATA.brandName;
  manifest.description = OKOU_APP_METADATA.description;

  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
  headers.set("Content-Type", "application/manifest+json; charset=UTF-8");
  return new Response(JSON.stringify(manifest), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteFound(response, title, canonicalUrl) {
  const sharedDescription = `A conversation shared from ${OKOU_APP_METADATA.brandName}`;
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(OKOU_APP_METADATA.brandName))
    .on(
      'meta[name="application-name"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on("title", {
      element(element) {
        element.setInnerContent(`${title} | ${OKOU_APP_METADATA.brandName}`);
      },
    })
    .on('meta[name="description"]', setMetaContent(sharedDescription))
    .on('meta[property="og:type"]', setMetaContent("website"))
    .on(
      'meta[property="og:site_name"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on('meta[property="og:title"]', setMetaContent(title))
    .on('meta[property="og:description"]', setMetaContent(sharedDescription))
    .on(
      'meta[property="og:image"]',
      setMetaContent(
        staticAssetUrl(OKOU_APP_METADATA, OKOU_APP_METADATA.socialImagePath),
      ),
    )
    .on('meta[property="og:image:alt"]', setMetaContent(title))
    .on('meta[name="twitter:title"]', setMetaContent(title))
    .on('meta[name="twitter:description"]', setMetaContent(sharedDescription))
    .on(
      'meta[name="twitter:image"]',
      setMetaContent(
        staticAssetUrl(OKOU_APP_METADATA, OKOU_APP_METADATA.socialImagePath),
      ),
    )
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex, nofollow" />', {
          html: true,
        });
        element.append(`<meta property="og:url" content="${canonicalUrl}" />`, {
          html: true,
        });
      },
    });
  return rewriter.transform(response);
}

function rewriteNotFound(response) {
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(OKOU_APP_METADATA.brandName))
    .on(
      'meta[name="application-name"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(OKOU_APP_METADATA.brandName),
    )
    .on("title", {
      element(element) {
        element.setInnerContent(
          `Shared conversation not found | ${OKOU_APP_METADATA.brandName}`,
        );
      },
    })
    .on('meta[property^="og:"]', removeElement())
    .on('meta[name^="twitter:"]', removeElement())
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex, nofollow" />', {
          html: true,
        });
      },
    });
  return rewriter.transform(response);
}

function gatewayResponse(status) {
  return new Response(status === 503 ? "Service unavailable" : "Bad gateway", {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=UTF-8",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function embeddedShellAsset(pathname, embeddedShell) {
  switch (pathname) {
    case "/index.html":
      return embeddedShell.indexHtml;
    case "/sw.js":
      return embeddedShell.serviceWorker;
    case "/manifest.webmanifest":
      return embeddedShell.manifest;
    case "/robots.txt":
      return embeddedShell.robots;
    case "/icons/icon-192.png":
      return embeddedShell.icon192;
    case "/icons/icon-512.png":
      return embeddedShell.icon512;
    case "/icons/icon-512-maskable.png":
      return embeddedShell.icon512Maskable;
    default:
      return embeddedShell.indexHtml;
  }
}

function embeddedShellResponse(request, embeddedShell) {
  if (!embeddedShell) {
    return null;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    });
  }

  const requestUrl = new URL(request.url);
  const exactContentType = EMBEDDED_SHELL_CONTENT_TYPES.get(
    requestUrl.pathname,
  );
  const pathname = exactContentType ? requestUrl.pathname : "/index.html";
  const sourceBody = embeddedShellAsset(pathname, embeddedShell);
  const body =
    pathname === "/index.html" && typeof sourceBody === "string"
      ? previewAppAssetHtml(sourceBody, requestUrl)
      : sourceBody;
  if (
    (pathname.startsWith("/icons/") && !(body instanceof ArrayBuffer)) ||
    (!pathname.startsWith("/icons/") && typeof body !== "string")
  ) {
    return gatewayResponse(503);
  }
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type":
        exactContentType ?? EMBEDDED_SHELL_CONTENT_TYPES.get("/index.html"),
    },
  });
}

function fetchShellAsset(request, embeddedShell) {
  const embeddedResponse = embeddedShellResponse(request, embeddedShell);
  return Promise.resolve(embeddedResponse ?? gatewayResponse(503));
}

function metaRequestHeaders(requestUrl, origin) {
  const headers = new Headers({ Accept: "application/json" });
  if (PREVIEW_API_ORIGIN_PATTERN.test(origin)) {
    const bypass = requestUrl.searchParams.get(VERCEL_PROTECTION_BYPASS);
    if (bypass) {
      headers.set(VERCEL_PROTECTION_BYPASS, bypass);
    }
  }
  return headers;
}

function appAssetRequestHeaders(request) {
  const headers = new Headers();
  for (const name of APP_ASSET_REQUEST_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function proxyAppAsset(request, requestUrl, env) {
  if (!env.STATIC_ASSETS_BUCKET) {
    const staticUrl = new URL(
      `${requestUrl.pathname}${requestUrl.search}`,
      OKOU_APP_METADATA.staticAssetsOrigin,
    );
    return fetch(
      new Request(staticUrl, {
        headers: appAssetRequestHeaders(request),
        method: request.method,
      }),
    );
  }

  const key = requestUrl.pathname.replace(/^\//u, "");
  const requestHeaders = appAssetRequestHeaders(request);
  const object = await env.STATIC_ASSETS_BUCKET.get(key, {
    onlyIf: requestHeaders,
    range: requestHeaders,
  });
  if (!object) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", object.httpEtag);
  if (!object.body) {
    return new Response(null, { headers, status: 304 });
  }

  let status = 200;
  if (object.range && "offset" in object.range) {
    const offset = object.range.offset;
    const length = object.range.length;
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
    status,
  });
}

function withAppHeaders(response, requestUrl) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (requestUrl.pathname === "/sw.js") {
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    headers.set("Service-Worker-Allowed", "/");
  } else if (requestUrl.pathname === "/robots.txt") {
    headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
  } else if (requestUrl.pathname.startsWith("/icons/")) {
    headers.set("Cache-Control", "public, max-age=3600, must-revalidate");
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function handleRequest(
  request,
  env,
  requestUrl,
  embeddedShell,
  clerkClientFactory,
  bootstrapFetcher,
) {
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    requestUrl.pathname.startsWith(APP_ASSET_PATH_PREFIX)
  ) {
    return proxyAppAsset(request, requestUrl, env);
  }
  const match = SHARED_THREAD_PATH.exec(requestUrl.pathname);
  if (match && request.method === "GET") {
    let assetResponse;
    let indexHtml;
    let origin;
    try {
      const indexRequestUrl = new URL("/index.html", requestUrl);
      assetResponse = await fetchShellAsset(
        new Request(indexRequestUrl),
        embeddedShell,
      );
      if (!assetResponse.ok) {
        return gatewayResponse(503);
      }
      indexHtml = await assetResponse.text();
      origin = apiOrigin(requestUrl);
    } catch {
      return gatewayResponse(503);
    }
    const metaUrl = `${origin}/api/shared-threads/${match[1]}/meta`;
    let metaResponse;
    try {
      metaResponse = await fetch(metaUrl, {
        headers: metaRequestHeaders(requestUrl, origin),
        cf: { cacheEverything: true },
      });
    } catch {
      return gatewayResponse(503);
    }

    if (metaResponse.status === 404) {
      return rewriteNotFound(
        htmlResponse(
          indexHtml,
          assetResponse,
          404,
          "public, max-age=60, s-maxage=60",
        ),
      );
    }
    if (!metaResponse.ok) {
      return gatewayResponse(metaResponse.status === 503 ? 503 : 502);
    }
    let metadata;
    try {
      metadata = await metaResponse.json();
    } catch {
      return gatewayResponse(502);
    }
    if (typeof metadata.title !== "string" || metadata.title.length === 0) {
      return gatewayResponse(502);
    }
    const canonicalUrl = new URL(
      requestUrl.pathname,
      OKOU_APP_METADATA.canonicalUrl,
    ).toString();
    return rewriteFound(
      htmlResponse(
        indexHtml,
        assetResponse,
        200,
        "public, max-age=0, must-revalidate",
      ),
      metadata.title,
      canonicalUrl,
    );
  }

  const assetResponse = await fetchShellAsset(request, embeddedShell);
  if (request.method !== "GET") {
    return assetResponse;
  }

  if (requestUrl.pathname === "/manifest.webmanifest") {
    return rewriteManifest(assetResponse);
  }
  if (
    !assetResponse.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("text/html")
  ) {
    return assetResponse;
  }
  const authorizedParty = clerkEdgeSessionAuthorizedParty(requestUrl, env);
  const edgeSessionPromise = authorizedParty
    ? clerkEdgeSession(request, env, authorizedParty, clerkClientFactory)
    : null;
  return rewriteAppPage(
    assetResponse,
    edgeSessionPromise,
    request,
    requestUrl,
    bootstrapFetcher,
  );
}

export function createWorker(
  embeddedShell,
  clerkClientFactory = createClerkClient,
  bootstrapFetcher = fetch,
) {
  return {
    async fetch(request, env) {
      const requestUrl = new URL(request.url);
      const response = await handleRequest(
        request,
        env,
        requestUrl,
        embeddedShell,
        clerkClientFactory,
        bootstrapFetcher,
      );
      return withAppHeaders(response, requestUrl);
    },
  };
}
