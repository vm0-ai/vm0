const SHARED_THREAD_PATH =
  /^\/share\/threads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/iu;
const PREVIEW_API_ORIGIN_PATTERN =
  /^https:\/\/(?:staging|pr-[0-9]+)-api\.vm6\.ai$/u;
const API_ORIGIN_MARKER_PATTERN =
  /<meta\s+name=["']vm0-api-origin["']\s+content=["']([^"']*)["']\s*\/?>/iu;
const PRODUCTION_APP_HOSTS = new Set(["app.okou.ai", "app.vm0.ai"]);
const PRODUCTION_API_ORIGIN = "https://api.vm0.ai";
const VERCEL_PROTECTION_BYPASS = "x-vercel-protection-bypass";
const SHARED_DESCRIPTION = "A conversation shared from Okou";
const SHARED_IMAGE = "https://static.vm0.io/web/og-image.png";

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

function rewriteFound(response, title, canonicalUrl) {
  return new HTMLRewriter()
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
    if (!match || request.method !== "GET") {
      return env.ASSETS.fetch(request);
    }

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
    const metaUrl = `${origin}/api/zero/shared-threads/${match[1]}/meta`;
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
  },
};
