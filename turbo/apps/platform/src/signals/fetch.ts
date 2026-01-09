import { computed } from "ccstate";
import { clerk$ } from "./auth.ts";
import { origin } from "./location.ts";

const apiBase$ = computed(() => {
  return origin();
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

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { headers, ...restOptions } = options ?? {};
      finalInit = {
        credentials: "include",
        method: "GET",
        ...restOptions,
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
      const HOST_URL = new Request("/").url;

      if (url.url.startsWith(HOST_URL)) {
        const combinedHeaders = new Headers(url.headers);

        if (token) {
          combinedHeaders.set("Authorization", `Bearer ${token}`);
        }

        if (finalInit.headers) {
          const newHeaders = new Headers(finalInit.headers);
          for (const [key, value] of newHeaders.entries()) {
            combinedHeaders.set(key, value);
          }
        }

        const requestInit: RequestInit & { duplex: "half" } = {
          method: url.method,
          headers: combinedHeaders,
          mode: url.mode,
          credentials: url.credentials,
          cache: url.cache,
          redirect: url.redirect,
          referrer: url.referrer,
          referrerPolicy: url.referrerPolicy,
          integrity: url.integrity,
          keepalive: url.keepalive,
          body: url.body,
          signal: url.signal,
          duplex: "half",
        };
        finalUrl = new Request(
          url.url.replace(
            HOST_URL,
            apiBase.endsWith("/") ? apiBase : apiBase + "/",
          ),
          requestInit,
        );
      }
    }

    return await fetch(finalUrl, finalInit);
  };
});
