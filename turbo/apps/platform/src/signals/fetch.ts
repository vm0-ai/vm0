import { computed } from "ccstate";
import { clerk$ } from "./auth.ts";

function getConfiguredApiUrl(): string {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  if (!url) {
    throw new Error("Missing VITE_API_URL environment variable");
  }
  return url;
}

const CONFIGURED_API_URL = getConfiguredApiUrl();

/**
 * Resolves the API base URL.
 * If VITE_API_URL is http://localhost:3000, derives the URL from the current browser origin
 * by replacing "platform" with "www" in the hostname.
 * Otherwise, uses VITE_API_URL directly.
 */
function resolveApiBase(): string {
  if (CONFIGURED_API_URL === "http://localhost:3000") {
    const currentOrigin = location.origin;
    const url = new URL(currentOrigin);
    url.hostname = url.hostname.replace("platform", "www");
    return url.origin;
  }
  return CONFIGURED_API_URL;
}

export const apiBase$ = computed(() => {
  return resolveApiBase();
});

function mergeHeadersWithAutoIds(
  baseHeaders: Record<string, string>,
  userHeaders: HeadersInit | undefined,
  autoHeaders: Record<string, string>,
): Record<string, string> {
  const result = { ...baseHeaders, ...autoHeaders };

  if (userHeaders) {
    if (userHeaders instanceof Headers) {
      for (const [key, value] of userHeaders.entries()) {
        result[key] = value;
      }
    } else if (typeof userHeaders === "object" && !Array.isArray(userHeaders)) {
      Object.assign(result, userHeaders);
    }
  }

  return result;
}

/**
 * Rewrite a Request URL from localhost to the API base, merging auth headers.
 */
function rewriteRequestUrl(
  request: Request,
  apiBase: string,
  token: string | null | undefined,
  initHeaders: HeadersInit | Record<string, string> | undefined,
): Request | null {
  const HOST_URL = new Request("/").url;

  if (!request.url.startsWith(HOST_URL)) {
    return null;
  }

  const combinedHeaders = new Headers(request.headers);

  if (token) {
    combinedHeaders.set("Authorization", `Bearer ${token}`);
  }

  if (initHeaders) {
    const newHeaders = new Headers(initHeaders);
    for (const [key, value] of newHeaders.entries()) {
      combinedHeaders.set(key, value);
    }
  }

  const requestInit: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers: combinedHeaders,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    keepalive: request.keepalive,
    body: request.body,
    signal: request.signal,
    duplex: "half",
  };
  return new Request(
    request.url.replace(
      HOST_URL,
      apiBase.endsWith("/") ? apiBase : apiBase + "/",
    ),
    requestInit,
  );
}

export const fetch$ = computed((get) => {
  return async (url: string | URL | Request, options?: RequestInit) => {
    const clerk = await get(clerk$);
    const token = await clerk.session?.getToken();

    const apiBase = get(apiBase$);

    let finalUrl: string | URL | Request = url;
    let finalInit: RequestInit | undefined = undefined;

    const authHeaders: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    if (url instanceof Request) {
      const combinedHeaders = new Headers(url.headers);

      if (token) {
        combinedHeaders.set("Authorization", `Bearer ${token}`);
      }

      if (options?.headers) {
        const optHeaders = new Headers(options.headers);
        for (const [key, value] of optHeaders.entries()) {
          combinedHeaders.set(key, value);
        }
      }

      const autoHeaders: Record<string, string> = {};

      finalInit = {
        credentials: "include",
        headers: mergeHeadersWithAutoIds(
          authHeaders,
          options?.headers,
          autoHeaders,
        ),
        ...options,
      };
    } else {
      const autoHeaders: Record<string, string> = {};

      finalInit = {
        credentials: "include",
        method: "GET",
        ...options,
        headers: mergeHeadersWithAutoIds(
          authHeaders,
          options?.headers,
          autoHeaders,
        ),
      };
    }

    if (typeof url === "string" && !url.includes("://")) {
      const baseUrl = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
      const path = url.startsWith("/") ? url : `/${url}`;
      finalUrl = `${baseUrl}${path}`;
    } else if (url instanceof URL && !url.host) {
      finalUrl = new URL(url.pathname + url.search + url.hash, apiBase);
    } else if (url instanceof Request) {
      const rewritten = rewriteRequestUrl(
        url,
        apiBase,
        token,
        finalInit.headers,
      );
      if (rewritten) {
        finalUrl = rewritten;
      }
    }

    return await fetch(finalUrl, finalInit);
  };
});
