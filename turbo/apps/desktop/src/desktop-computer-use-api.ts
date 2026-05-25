import type { ComputerUseHostFetch } from "./computer-use-host";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";

export function createDesktopComputerUseSessionFetch(params: {
  readonly platformUrl: URL;
  readonly session: DesktopSessionCookieSource;
  readonly getAuthToken?: (options?: {
    readonly forceRefresh?: boolean;
  }) => Promise<string | null> | string | null;
}): ComputerUseHostFetch {
  return async (input, init) => {
    const requestUrl = new URL(input);
    const buildHeaders = async (forceRefresh: boolean): Promise<Headers> => {
      const headers = await headersWithSessionCookies(
        params.session,
        [params.platformUrl, requestUrl],
        init?.headers,
      );
      const token = await params.getAuthToken?.({ forceRefresh });
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
      return headers;
    };

    const response = await fetch(input, {
      ...init,
      headers: await buildHeaders(false),
    });
    if (response.status !== 401 || !params.getAuthToken) {
      return response;
    }
    return fetch(input, { ...init, headers: await buildHeaders(true) });
  };
}
