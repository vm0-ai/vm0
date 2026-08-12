const SHARED_THREAD_PATH =
  /^\/share\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;
const PREVIEW_API_ORIGIN_PATTERN =
  /^https:\/\/(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const API_ORIGIN_MARKER_PATTERN =
  /<meta\s+name=["']vm0-api-origin["']\s+content=["']([^"']*)["']\s*\/?>/iu;
const OKOU_ROOT_DOMAINS = ["okou.ai", "omby.ai", "okou-app.pages.dev"];
const PRODUCTION_APP_HOSTS = new Set(["app.okou.ai", "app.vm0.ai"]);
const PRODUCTION_API_ORIGIN = "https://api.vm0.ai";
const VERCEL_PROTECTION_BYPASS = "x-vercel-protection-bypass";
const SHARED_DESCRIPTION = "A conversation shared from Okou";
const APP_IMAGE = "https://static.vm0.io/web/og-image.png";
const SHARED_IMAGE = APP_IMAGE;

const VM0_APP_METADATA = {
  brandName: "VM0",
  canonicalUrl: "https://app.vm0.ai/",
  description:
    "VM0, your trustworthy AI teammate for real work. An AI agent that connects to 100+ tools to run reports, triage, outreach, and research in Slack or the web.",
  documentTitle: "AI Agents for Real Work — Your Trustworthy AI Teammate | VM0",
  openGraphTitle: "VM0 - Your Trustworthy AI Teammate",
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
  const marker = API_ORIGIN_MARKER_PATTERN.exec(indexHtml)?.[1]?.trim();
  if (marker) {
    if (!PREVIEW_API_ORIGIN_PATTERN.test(marker)) {
      throw new Error("Invalid shared-thread preview API origin");
    }
    return marker;
  }
  if (PRODUCTION_APP_HOSTS.has(requestUrl.hostname)) {
    return PRODUCTION_API_ORIGIN;
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

function rewriteAppPage(response, metadata) {
  const rewrittenResponse = new HTMLRewriter()
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
    .on('meta[property="og:image"]', setMetaContent(APP_IMAGE))
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
    .on('meta[name="twitter:image"]', setMetaContent(APP_IMAGE))
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
    })
    .transform(response);
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

function rewriteFound(response, title, canonicalUrl) {
  return new HTMLRewriter()
    .on("html", setBrandContext("Okou"))
    .on('meta[name="application-name"]', setMetaContent("Okou"))
    .on('meta[name="apple-mobile-web-app-title"]', setMetaContent("Okou"))
    .on("title", {
      element(element) {
        element.setInnerContent(`${title} | Okou`);
      },
    })
    .on('meta[name="description"]', setMetaContent(SHARED_DESCRIPTION))
    .on('meta[property="og:type"]', setMetaContent("website"))
    .on('meta[property="og:site_name"]', setMetaContent("Okou"))
    .on('meta[property="og:title"]', setMetaContent(title))
    .on('meta[property="og:description"]', setMetaContent(SHARED_DESCRIPTION))
    .on('meta[property="og:image"]', setMetaContent(SHARED_IMAGE))
    .on('meta[property="og:image:alt"]', setMetaContent(title))
    .on('meta[name="twitter:title"]', setMetaContent(title))
    .on('meta[name="twitter:description"]', setMetaContent(SHARED_DESCRIPTION))
    .on('meta[name="twitter:image"]', setMetaContent(SHARED_IMAGE))
    .on("head", {
      element(element) {
        element.append('<meta name="robots" content="noindex, nofollow" />', {
          html: true,
        });
        element.append(`<meta property="og:url" content="${canonicalUrl}" />`, {
          html: true,
        });
      },
    })
    .transform(response);
}

function rewriteNotFound(response) {
  return new HTMLRewriter()
    .on("html", setBrandContext("Okou"))
    .on('meta[name="application-name"]', setMetaContent("Okou"))
    .on('meta[name="apple-mobile-web-app-title"]', setMetaContent("Okou"))
    .on("title", {
      element(element) {
        element.setInnerContent("Shared conversation not found | Okou");
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
    })
    .transform(response);
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

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
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
      const metaUrl = `${origin}/api/okou/shared-threads/${match[1]}/meta`;
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
      const canonicalUrl = `${requestUrl.origin}${requestUrl.pathname}`;
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
    return rewriteAppPage(assetResponse, metadata);
  },
};
