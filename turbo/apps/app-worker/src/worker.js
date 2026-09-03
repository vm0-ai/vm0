const SHARED_THREAD_PATH =
  /^\/share\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;
const PREVIEW_API_ORIGIN_PATTERN =
  /^https:\/\/(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const PREVIEW_APP_HOSTNAME_PATTERNS = [
  /^(staging|pr-[0-9]+)-app\.omby\.ai$/u,
  /^(staging|pr-[0-9]+)-app-okou-app-preview\.vm0\.workers\.dev$/u,
];
const APP_ASSET_PATH_PREFIX = "/okou-app/assets/";
const APP_ASSET_REQUEST_HEADER_NAMES = [
  "Accept",
  "If-Modified-Since",
  "If-None-Match",
  "Range",
];
const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai"];
const PRODUCTION_API_ORIGINS = new Map([
  ["app.okou.ai", "https://api.okou.ai"],
  ["app-worker.okou.ai", "https://api.okou.ai"],
  ["app.vm0.ai", "https://api.vm0.ai"],
  ["app-worker.vm0.ai", "https://api.vm0.ai"],
]);
const VERCEL_PROTECTION_BYPASS = "x-vercel-protection-bypass";
const CLERK_EDGE_DEBUG_QUERY_PARAMETER = "__clerk_edge_debug";
const CLERK_EDGE_DEBUG_TIMEOUT_MS = 1000;
const CLERK_EDGE_DEBUG_PREVIEW_HOSTNAME_PATTERN =
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

const VM0_APP_METADATA = {
  brandName: "VM0",
  canonicalUrl: "https://app.vm0.ai/",
  description:
    "VM0, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.",
  documentTitle: "AI Agents for Real Work — Your Trustworthy AI Teammate | VM0",
  openGraphTitle: "VM0 - Your Trustworthy AI Teammate",
  staticAssetsOrigin: "https://static.vm0.io",
  twitterDescription:
    "VM0 is an AI agent that connects to 100+ tools and does the work. Reports, triage, outreach, research. In Slack or on the web.",
};

const OKOU_APP_METADATA = {
  brandName: "Okou",
  canonicalUrl: "https://app.okou.ai/",
  description:
    "Okou, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.",
  documentTitle:
    "AI Agents for Real Work — Your Trustworthy AI Teammate | Okou",
  openGraphTitle: "Okou - Your Trustworthy AI Teammate",
  staticAssetsOrigin: "https://static.okou.io",
  twitterDescription:
    "Okou is an AI agent that connects to 100+ tools and does the work. Reports, triage, outreach, research. In Slack or on the web.",
};

function appMetadata(hostname, configuredPublicBrand) {
  if (configuredPublicBrand === "okou") {
    return OKOU_APP_METADATA;
  }
  if (configuredPublicBrand === "vm0") {
    return VM0_APP_METADATA;
  }
  const normalizedHostname = hostname.toLowerCase();
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return (
      normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`)
    );
  });
  return isOkou ? OKOU_APP_METADATA : VM0_APP_METADATA;
}

function apiOrigin(requestUrl) {
  const productionApiOrigin = PRODUCTION_API_ORIGINS.get(requestUrl.hostname);
  if (productionApiOrigin) {
    return productionApiOrigin;
  }

  for (const pattern of PREVIEW_APP_HOSTNAME_PATTERNS) {
    const previewApp = pattern.exec(requestUrl.hostname);
    if (previewApp) {
      return `https://${previewApp[1]}-api.vm6.ai`;
    }
  }
  throw new Error("Shared-thread API origin is unavailable");
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
  return indexHtml
    .replaceAll(
      `${VM0_APP_METADATA.staticAssetsOrigin}${APP_ASSET_PATH_PREFIX}`,
      previewAssetBase,
    )
    .replaceAll(
      `${OKOU_APP_METADATA.staticAssetsOrigin}${APP_ASSET_PATH_PREFIX}`,
      previewAssetBase,
    );
}

function rewriteStaticAssetAttribute(attributeName, staticAssetsOrigin) {
  return {
    element(element) {
      const value = element.getAttribute(attributeName);
      if (value === null) {
        return;
      }
      const rewritten = value.replace(
        /^https:\/\/static\.(?:vm0|okou)\.io(?=\/|$)/u,
        staticAssetsOrigin,
      );
      if (rewritten !== value) {
        element.setAttribute(attributeName, rewritten);
      }
    },
  };
}

function addStaticAssetHandlers(rewriter, metadata) {
  rewriter
    .on(
      'link[rel="icon"]',
      rewriteStaticAssetAttribute("href", metadata.staticAssetsOrigin),
    )
    .on(
      'link[rel="preconnect"]',
      rewriteStaticAssetAttribute("href", metadata.staticAssetsOrigin),
    )
    .on(
      'link[rel="apple-touch-icon"]',
      rewriteStaticAssetAttribute("href", metadata.staticAssetsOrigin),
    )
    .on("img", rewriteStaticAssetAttribute("src", metadata.staticAssetsOrigin));
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

function isClerkEdgeDebugRequest(requestUrl, env) {
  const debugFlags = requestUrl.searchParams.getAll(
    CLERK_EDGE_DEBUG_QUERY_PARAMETER,
  );
  return (
    requestUrl.protocol === "https:" &&
    debugFlags.length === 1 &&
    debugFlags[0] === "1" &&
    CLERK_EDGE_DEBUG_PREVIEW_HOSTNAME_PATTERN.test(requestUrl.hostname) &&
    env.CLERK_EDGE_DEBUG_AUTHORIZED_PARTY === requestUrl.origin
  );
}

async function createClerkBackendClient(options) {
  const { createClerkClient } = await import("@clerk/backend");
  return createClerkClient(options);
}

async function clerkEdgeSession(request, env, requestUrl, clerkClientFactory) {
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
      }, CLERK_EDGE_DEBUG_TIMEOUT_MS);
    });
    const authentication = Promise.resolve().then(async () => {
      const clerk = await clerkClientFactory({
        publishableKey,
        secretKey,
        telemetry: { disabled: true },
      });
      return clerk.authenticateRequest(request, {
        acceptsToken: "session_token",
        authorizedParties: [env.CLERK_EDGE_DEBUG_AUTHORIZED_PARTY],
      });
    });
    const requestState = await Promise.race([authentication, timeout]);
    // Browser mutations are outside this observation-only diagnostic branch.
    if (
      requestState === null ||
      !requestState.isAuthenticated ||
      requestState.headers.has("Location") ||
      requestState.headers.has("Set-Cookie")
    ) {
      return null;
    }

    const { userId, orgId } = requestState.toAuth();
    if (
      typeof userId !== "string" ||
      userId.length === 0 ||
      (orgId !== null && typeof orgId !== "string")
    ) {
      return null;
    }
    return { userId, orgId };
  } catch {
    // Clerk must never affect availability of the existing app shell.
    return null;
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
  }
}

function rewriteAppPage(response, metadata, edgeSession) {
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(metadata.brandName))
    .on("title", {
      element(element) {
        element.setInnerContent(metadata.documentTitle);
      },
    })
    .on('meta[name="application-name"]', setMetaContent(metadata.brandName))
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(metadata.brandName),
    )
    .on('meta[name="description"]', setMetaContent(metadata.description))
    .on('meta[property="og:type"]', setMetaContent("website"))
    .on('meta[property="og:site_name"]', setMetaContent(metadata.brandName))
    .on('meta[property="og:title"]', setMetaContent(metadata.openGraphTitle))
    .on('meta[property="og:description"]', setMetaContent(metadata.description))
    .on(
      'meta[property="og:image"]',
      setMetaContent(staticAssetUrl(metadata, "web/og-image.png")),
    )
    .on(
      'meta[property="og:image:alt"]',
      setMetaContent(metadata.openGraphTitle),
    )
    .on('meta[name="twitter:card"]', setMetaContent("summary_large_image"))
    .on('meta[name="twitter:site"]', setMetaContent("@okou_ai"))
    .on('meta[name="twitter:creator"]', setMetaContent("@okou_ai"))
    .on('meta[name="twitter:title"]', setMetaContent(metadata.openGraphTitle))
    .on(
      'meta[name="twitter:description"]',
      setMetaContent(metadata.twitterDescription),
    )
    .on(
      'meta[name="twitter:image"]',
      setMetaContent(staticAssetUrl(metadata, "web/og-image.png")),
    )
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex, nofollow" />', {
          html: true,
        });
        element.append(
          `<link rel="canonical" href="${metadata.canonicalUrl}" />`,
          { html: true },
        );
        element.append(
          `<meta property="og:url" content="${metadata.canonicalUrl}" />`,
          { html: true },
        );
      },
    });
  addStaticAssetHandlers(rewriter, metadata);
  if (edgeSession !== null) {
    rewriter.on("body", {
      element(element) {
        element.append(
          `<script type="application/json" id="vm0-clerk-edge-session">${serializeClerkEdgeSession(edgeSession)}</script>`,
          { html: true },
        );
      },
    });
  }
  const rewrittenResponse = rewriter.transform(response);
  return noIndexResponse(
    rewrittenResponse,
    edgeSession === null
      ? "public, max-age=0, must-revalidate"
      : "private, no-store",
  );
}

async function rewriteManifest(response, metadata) {
  const manifest = await response.json();
  manifest.name = metadata.brandName;
  manifest.short_name = metadata.brandName;
  manifest.description = metadata.description;

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

function rewriteFound(response, title, canonicalUrl, metadata) {
  const sharedDescription = `A conversation shared from ${metadata.brandName}`;
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(metadata.brandName))
    .on('meta[name="application-name"]', setMetaContent(metadata.brandName))
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(metadata.brandName),
    )
    .on("title", {
      element(element) {
        element.setInnerContent(`${title} | ${metadata.brandName}`);
      },
    })
    .on('meta[name="description"]', setMetaContent(sharedDescription))
    .on('meta[property="og:type"]', setMetaContent("website"))
    .on('meta[property="og:site_name"]', setMetaContent(metadata.brandName))
    .on('meta[property="og:title"]', setMetaContent(title))
    .on('meta[property="og:description"]', setMetaContent(sharedDescription))
    .on(
      'meta[property="og:image"]',
      setMetaContent(staticAssetUrl(metadata, "web/og-image.png")),
    )
    .on('meta[property="og:image:alt"]', setMetaContent(title))
    .on('meta[name="twitter:title"]', setMetaContent(title))
    .on('meta[name="twitter:description"]', setMetaContent(sharedDescription))
    .on(
      'meta[name="twitter:image"]',
      setMetaContent(staticAssetUrl(metadata, "web/og-image.png")),
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
  addStaticAssetHandlers(rewriter, metadata);
  return rewriter.transform(response);
}

function rewriteNotFound(response, metadata) {
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(metadata.brandName))
    .on('meta[name="application-name"]', setMetaContent(metadata.brandName))
    .on(
      'meta[name="apple-mobile-web-app-title"]',
      setMetaContent(metadata.brandName),
    )
    .on("title", {
      element(element) {
        element.setInnerContent(
          `Shared conversation not found | ${metadata.brandName}`,
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
  addStaticAssetHandlers(rewriter, metadata);
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
      origin = apiOrigin(requestUrl, indexHtml);
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
        appMetadata(requestUrl.hostname, env.PUBLIC_BRAND),
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
    if (
      typeof metadata.title !== "string" ||
      metadata.title.length === 0 ||
      (metadata.publicBrand !== "vm0" && metadata.publicBrand !== "okou")
    ) {
      return gatewayResponse(502);
    }
    const publicBrand = metadata.publicBrand;
    const sharedAppMetadata =
      publicBrand === "okou" ? OKOU_APP_METADATA : VM0_APP_METADATA;
    const canonicalUrl = new URL(
      requestUrl.pathname,
      sharedAppMetadata.canonicalUrl,
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
      sharedAppMetadata,
    );
  }

  const assetResponse = await fetchShellAsset(request, embeddedShell);
  if (request.method !== "GET") {
    return assetResponse;
  }

  const metadata = appMetadata(requestUrl.hostname, env.PUBLIC_BRAND);
  if (requestUrl.pathname === "/manifest.webmanifest") {
    return rewriteManifest(assetResponse, metadata);
  }
  if (
    !assetResponse.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("text/html")
  ) {
    return assetResponse;
  }
  const edgeSession = isClerkEdgeDebugRequest(requestUrl, env)
    ? await clerkEdgeSession(request, env, requestUrl, clerkClientFactory)
    : null;
  return rewriteAppPage(assetResponse, metadata, edgeSession);
}

export function createWorker(
  embeddedShell,
  clerkClientFactory = createClerkBackendClient,
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
      );
      return withAppHeaders(response, requestUrl);
    },
  };
}
