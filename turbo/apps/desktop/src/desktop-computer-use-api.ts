import type { ComputerUseHostFetch } from "./computer-use-host";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";

export function createDesktopComputerUseSessionFetch(params: {
  readonly platformUrl: URL;
  readonly session: DesktopSessionCookieSource;
  readonly getCachedAuthToken?: () => Promise<string | null> | string | null;
  readonly getAuthToken?: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<string | null> | string | null;
}): ComputerUseHostFetch {
  return async (input, init) => {
    const requestUrl = new URL(input);
    const buildHeaders = async (token: string | null): Promise<Headers> => {
      const headers = await headersWithSessionCookies(
        params.session,
        [params.platformUrl, requestUrl],
        init?.headers,
      );
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
      return headers;
    };

    const cachedToken = (await params.getCachedAuthToken?.()) ?? null;
    const response = await fetch(input, {
      ...init,
      headers: await buildHeaders(cachedToken),
    });
    if (response.status !== 401 || !params.getAuthToken) {
      return response;
    }

    const refreshedToken = await params.getAuthToken({ forceRefresh: true });
    if (!refreshedToken) {
      return response;
    }

    return fetch(input, {
      ...init,
      headers: await buildHeaders(refreshedToken),
    });
  };
}
