import { computed } from "ccstate";
import { apiBackendEnabled$ } from "./external/feature-switch.ts";
import { clerk$ } from "./auth.ts";
import { fetchFreshToken, handleUnauthorizedRedirect } from "./auth-retry.ts";
import { resolveApiBase, resolveApiBaseForNavigation } from "./api-base.ts";

/**
 * API base URL for opening external navigation (e.g. connector OAuth popup).
 * - On localhost: use VITE_API_URL so the popup hits the configured API (e.g. :3000).
 * - On a non-localhost host (e.g. app.vm7.ai): derive from current origin
 *   (e.g. www.vm7.ai) so we never open a localhost URL when the user is remote.
 */
export const apiBaseForNavigation$ = computed(async (get) => {
  return resolveApiBaseForNavigation(await get(apiBackendEnabled$));
});

/**
 * Resolves the API base URL.
 * If VITE_API_URL is http://localhost:3000, derives the URL from the current browser origin
 * by replacing "platform" or "app" with "www" in the hostname.
 * Otherwise, uses VITE_API_URL directly.
 */
export const apiBase$ = computed(async (get) => {
  return resolveApiBase(await get(apiBackendEnabled$));
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
    const initialToken = (await clerk.session?.getToken()) ?? null;
    const apiBase = await get(apiBase$);

    const performFetch = async (token: string | null): Promise<Response> => {
      // Clone Request inputs so the body stream is available for retry.
      const requestInput = url instanceof Request ? url.clone() : url;

      let finalUrl: string | URL | Request = requestInput;
      let finalInit: RequestInit;

      const authHeaders: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      const autoHeaders: Record<string, string> = {};

      if (requestInput instanceof Request) {
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

      if (typeof requestInput === "string" && !requestInput.includes("://")) {
        const baseUrl = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
        const path = requestInput.startsWith("/")
          ? requestInput
          : `/${requestInput}`;
        finalUrl = `${baseUrl}${path}`;
      } else if (requestInput instanceof URL && !requestInput.host) {
        finalUrl = new URL(
          requestInput.pathname + requestInput.search + requestInput.hash,
          apiBase,
        );
      } else if (requestInput instanceof Request) {
        const rewritten = rewriteRequestUrl(
          requestInput,
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

    let response = await performFetch(initialToken);

    if (response.status === 401) {
      const freshToken = await fetchFreshToken(clerk, initialToken);
      if (freshToken) {
        response = await performFetch(freshToken);
      }
      if (response.status === 401) {
        handleUnauthorizedRedirect(clerk);
      }
    }

    return response;
  };
});
