import type { ComputerUseHostFetch } from "./computer-use-host";
import {
  headersWithSessionCookies,
  type DesktopSessionCookieSource,
} from "./desktop-session-cookies";

export function createDesktopComputerUseSessionFetch(params: {
  readonly platformUrl: URL;
  readonly session: DesktopSessionCookieSource;
}): ComputerUseHostFetch {
  return async (input, init) => {
    const requestUrl = new URL(input);
    const headers = await headersWithSessionCookies(
      params.session,
      [params.platformUrl, requestUrl],
      init?.headers,
    );
    return fetch(input, { ...init, headers });
  };
}
