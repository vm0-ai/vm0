import { computed } from "ccstate";
import { addCapturedPreviewBypassHeader } from "../lib/preview-bypass-cookie.ts";
import { clerk$ } from "./auth.ts";
import {
  fetchFreshToken,
  handleUnauthorizedRedirect,
  unauthorizedRedirectSuppressionUntil$,
} from "./auth-retry.ts";
import { resolveApiBase, resolveOAuthApiBase } from "./api-base.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";

/**
 * OAuth navigation uses the direct API in preview/development so those
 * environments do not depend on a WWW proxy. Production keeps the canonical
 * WWW route registered with providers.
 */
export const oauthBaseForNavigation$ = computed(() => {
  return resolveOAuthApiBase();
});

/**
 * Resolves the API base URL.
 * Derives the API URL from the current browser origin by preserving the root
 * domain and replacing the service subdomain segment ("platform", "app", or
 * "www") with "api".
 */
export const apiBase$ = computed(() => {
  return resolveApiBase();
});

function mergeHeadersWithClientHeaders(
  baseHeaders: Record<string, string>,
  userHeaders: HeadersInit | undefined,
): Headers {
  const headers = new Headers(baseHeaders);

  if (userHeaders) {
    const newHeaders = new Headers(userHeaders);
    for (const [key, value] of newHeaders.entries()) {
      headers.set(key, value);
    }
  }

  addClientHeaders(headers);
  return headers;
}

/**
 * Rewrite a Request URL from localhost to the API base, merging auth headers.
 */
function rewriteRequestUrl(
  request: Request,
  apiBase: string,
  method: string | undefined,
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
    method: method ?? request.method,
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

    const performFetch = async (token: string | null): Promise<Response> => {
      // Clone Request inputs so the body stream is available for retry.
      const requestInput = url instanceof Request ? url.clone() : url;

      let finalUrl: string | URL | Request = requestInput;
      let finalInit: RequestInit;

      const authHeaders: Record<string, string> = token
        ? { Authorization: `Bearer ${token}` }
        : {};
      if (requestInput instanceof Request) {
        finalInit = {
          credentials: "include",
          ...options,
          headers: mergeHeadersWithClientHeaders(authHeaders, options?.headers),
        };
      } else {
        finalInit = {
          credentials: "include",
          method: "GET",
          ...options,
          headers: mergeHeadersWithClientHeaders(authHeaders, options?.headers),
        };
      }

      if (typeof requestInput === "string" && !requestInput.includes("://")) {
        const path = requestInput.startsWith("/")
          ? requestInput
          : `/${requestInput}`;
        const apiBase = resolveApiBase();
        const baseUrl = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
        finalUrl = `${baseUrl}${path}`;
      } else if (requestInput instanceof URL && !requestInput.host) {
        const apiBase = resolveApiBase();
        finalUrl = new URL(
          requestInput.pathname + requestInput.search + requestInput.hash,
          apiBase,
        );
      } else if (requestInput instanceof Request) {
        const requestMethod = finalInit.method ?? requestInput.method;
        const apiBase = resolveApiBase();
        const rewritten = rewriteRequestUrl(
          requestInput,
          apiBase,
          requestMethod,
          token,
          finalInit.headers,
        );
        if (rewritten) {
          finalUrl = rewritten;
        }
      }

      const finalHeaders = new Headers(finalInit.headers);
      addCapturedPreviewBypassHeader(finalHeaders, finalUrl);
      finalInit.headers = finalHeaders;

      return await fetch(finalUrl, finalInit);
    };

    let response = await performFetch(initialToken);

    if (response.status === 401) {
      const refreshResult = await fetchFreshToken(clerk, initialToken);
      if (refreshResult.status === "refreshed") {
        response = await performFetch(refreshResult.token);
      }
      if (response.status === 401 && refreshResult.status !== "offline") {
        handleUnauthorizedRedirect(
          clerk,
          get(unauthorizedRedirectSuppressionUntil$),
        );
      }
    }

    reportForceUpgradeResponse(response);

    return response;
  };
});
