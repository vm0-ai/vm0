export interface DesktopSessionCookie {
  readonly name: string;
  readonly value: string;
}

export interface DesktopSessionCookieSource {
  readonly cookies: {
    readonly get: (filter: {
      readonly url: string;
    }) => Promise<readonly DesktopSessionCookie[]>;
  };
}

async function cookieHeaderForSession(
  electronSession: DesktopSessionCookieSource,
  urls: readonly URL[],
): Promise<string> {
  const pairs = new Map<string, string>();
  for (const url of urls) {
    const cookies = await electronSession.cookies.get({ url: url.toString() });
    for (const cookie of cookies) {
      pairs.set(cookie.name, `${cookie.name}=${cookie.value}`);
    }
  }
  return [...pairs.values()].join("; ");
}

export async function headersWithSessionCookies(
  electronSession: DesktopSessionCookieSource,
  urls: readonly URL[],
  headersInit?: HeadersInit,
): Promise<Headers> {
  const headers = new Headers(headersInit);
  const cookie = await cookieHeaderForSession(electronSession, urls);
  if (cookie.length > 0) {
    headers.set("cookie", cookie);
  }
  return headers;
}
