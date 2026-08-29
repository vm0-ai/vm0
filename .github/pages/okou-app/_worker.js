const SHARED_THREAD_PATH =
  /^\/share\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;
const PREVIEW_API_ORIGIN_PATTERN =
  /^https:\/\/(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const API_ORIGIN_MARKER_PATTERN =
  /<meta\s+name=["']vm0-api-origin["']\s+content=["']([^"']*)["']\s*\/?>/iu;
const APP_ASSET_PATH_PREFIX = "/okou-app/assets/";
const APP_ASSET_REQUEST_HEADER_NAMES = [
  "Accept",
  "If-Modified-Since",
  "If-None-Match",
  "Range",
];
const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"];
const PRODUCTION_API_ORIGINS = new Map([
  ["app.okou.ai", "https://api.okou.ai"],
  ["app.vm0.ai", "https://api.vm0.ai"],
]);
const VERCEL_PROTECTION_BYPASS = "x-vercel-protection-bypass";
const PRODUCTION_ROOT_DOMAINS = ["okou.ai", "vm0.ai"];
const CLERK_SATELLITE_DOMAIN = "app.okou.ai";
const CLERK_SCRIPT_SELECTOR = "script[data-clerk-js-script]";
const CLERK_PRODUCTION_PUBLISHABLE_KEY_ATTRIBUTE =
  "data-vm0-clerk-production-publishable-key";
const CLERK_PRODUCTION_SCRIPT_URL_ATTRIBUTE =
  "data-vm0-clerk-production-script-url";
const CLERK_SATELLITE_SCRIPT_URL_ATTRIBUTE =
  "data-vm0-clerk-satellite-script-url";

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

function appMetadata(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  const isOkou = OKOU_ROOT_DOMAINS.some((domain) => {
    return (
      normalizedHostname === domain || normalizedHostname.endsWith(`.${domain}`)
    );
  });
  return isOkou ? OKOU_APP_METADATA : VM0_APP_METADATA;
}

function apiOrigin(requestUrl, indexHtml) {
  const productionApiOrigin = PRODUCTION_API_ORIGINS.get(requestUrl.hostname);
  if (productionApiOrigin) {
    return productionApiOrigin;
  }

  const marker = API_ORIGIN_MARKER_PATTERN.exec(indexHtml)?.[1]?.trim();
  if (marker) {
    if (!PREVIEW_API_ORIGIN_PATTERN.test(marker)) {
      throw new Error("Invalid shared-thread preview API origin");
    }
    return marker;
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

function isProductionHostname(hostname) {
  return PRODUCTION_ROOT_DOMAINS.some((domain) => {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  });
}

function isClerkSatelliteHostname(hostname) {
  return (
    hostname === CLERK_SATELLITE_DOMAIN ||
    hostname.endsWith(`.${CLERK_SATELLITE_DOMAIN}`)
  );
}

function addClerkScriptHandler(rewriter, hostname) {
  const normalizedHostname = hostname.toLowerCase();
  if (!isProductionHostname(normalizedHostname)) {
    return;
  }
  rewriter.on(CLERK_SCRIPT_SELECTOR, {
    element(element) {
      const publishableKey = element.getAttribute(
        CLERK_PRODUCTION_PUBLISHABLE_KEY_ATTRIBUTE,
      );
      const satellite = isClerkSatelliteHostname(normalizedHostname);
      const scriptUrl = element.getAttribute(
        satellite
          ? CLERK_SATELLITE_SCRIPT_URL_ATTRIBUTE
          : CLERK_PRODUCTION_SCRIPT_URL_ATTRIBUTE,
      );
      if (publishableKey === null || scriptUrl === null) {
        throw new Error("Clerk production script configuration is unavailable");
      }
      element.setAttribute("data-clerk-publishable-key", publishableKey);
      element.setAttribute("src", scriptUrl);
      if (satellite) {
        element.setAttribute("data-clerk-domain", CLERK_SATELLITE_DOMAIN);
      }
    },
  });
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

function noIndexResponse(response) {
  const headers = new Headers(response.headers);
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteAppPage(response, metadata, productionApiOrigin, hostname) {
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
  addClerkScriptHandler(rewriter, hostname);
  if (productionApiOrigin) {
    rewriter.on(
      'meta[name="vm0-api-origin"]',
      setMetaContent(productionApiOrigin),
    );
  }
  const rewrittenResponse = rewriter.transform(response);
  return noIndexResponse(rewrittenResponse);
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
  headers.set("Content-Type", "application/manifest+json; charset=UTF-8");
  return new Response(JSON.stringify(manifest), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteFound(
  response,
  title,
  canonicalUrl,
  metadata,
  apiOrigin,
  hostname,
) {
  const sharedDescription = `A conversation shared from ${metadata.brandName}`;
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(metadata.brandName))
    .on('meta[name="vm0-api-origin"]', setMetaContent(apiOrigin))
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
  addClerkScriptHandler(rewriter, hostname);
  return rewriter.transform(response);
}

function rewriteNotFound(response, metadata, apiOrigin, hostname) {
  const rewriter = new HTMLRewriter()
    .on("html", setBrandContext(metadata.brandName))
    .on('meta[name="vm0-api-origin"]', setMetaContent(apiOrigin))
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
  addClerkScriptHandler(rewriter, hostname);
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

function proxyAppAsset(request, requestUrl) {
  const staticUrl = new URL(
    `${requestUrl.pathname}${requestUrl.search}`,
    OKOU_APP_METADATA.staticAssetsOrigin,
  );
  const headers = new Headers();
  for (const name of APP_ASSET_REQUEST_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return fetch(
    new Request(staticUrl, {
      headers,
      method: request.method,
    }),
  );
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      requestUrl.pathname.startsWith(APP_ASSET_PATH_PREFIX)
    ) {
      return proxyAppAsset(request, requestUrl);
    }
    const match = SHARED_THREAD_PATH.exec(requestUrl.pathname);
    if (match && request.method === "GET") {
      let assetResponse;
      let indexHtml;
      let origin;
      try {
        const indexRequestUrl = new URL("/index.html", requestUrl);
        assetResponse = await env.ASSETS.fetch(indexRequestUrl);
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
          appMetadata(requestUrl.hostname),
          origin,
          requestUrl.hostname,
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
        origin,
        requestUrl.hostname,
      );
    }

    const assetResponse = await env.ASSETS.fetch(request);
    if (request.method !== "GET") {
      return assetResponse;
    }

    const metadata = appMetadata(requestUrl.hostname);
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
    return rewriteAppPage(
      assetResponse,
      metadata,
      PRODUCTION_API_ORIGINS.get(requestUrl.hostname),
      requestUrl.hostname,
    );
  },
};
