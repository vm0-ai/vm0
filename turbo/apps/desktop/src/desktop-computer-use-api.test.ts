import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@vm0/api-contracts/contracts/client-headers";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
import type { DesktopSessionCookieSource } from "./desktop-session-cookies";

const noopAddClientHeaders = () => {};

function uuidSequence(...values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (!value) {
      throw new Error("UUID sequence exhausted");
    }
    return value;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDesktopComputerUseSessionFetch", () => {
  it("forwards desktop session cookies to Computer Use host registration", async () => {
    const cookieUrls: string[] = [];
    const session: DesktopSessionCookieSource = {
      cookies: {
        async get(filter) {
          cookieUrls.push(filter.url);
          if (filter.url === "https://app.vm0.ai/") {
            return [{ name: "app_session", value: "app-cookie" }];
          }
          if (
            filter.url ===
            "https://api.vm0.ai/api/zero/computer-use/hosts/start"
          ) {
            return [{ name: "api_session", value: "api-cookie" }];
          }
          return [];
        },
      },
    };
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        return jsonResponse({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessionFetch = createDesktopComputerUseSessionFetch({
      platformUrl: new URL("https://app.vm0.ai"),
      session,
      addClientHeaders: createDesktopClientHeaderInjector({
        clientVersion: "1.2.3",
        createUuid: uuidSequence("session-id", "request-id-1"),
      }),
      getCachedAuthToken: () => {
        return "desktop-token";
      },
    });
    await sessionFetch("https://api.vm0.ai/api/zero/computer-use/hosts/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CLIENT_VERSION_HEADER]: "caller-version",
        [CLIENT_TYPE_HEADER]: "caller-type",
        [CLIENT_SESSION_ID_HEADER]: "caller-session-id",
        [CLIENT_REQUEST_ID_HEADER]: "caller-request-id",
      },
    });

    expect(cookieUrls).toStrictEqual([
      "https://app.vm0.ai/",
      "https://api.vm0.ai/api/zero/computer-use/hosts/start",
    ]);
    const call = fetchMock.mock.calls[0];
    if (!call) {
      throw new Error("Expected fetch to be called");
    }
    const init = call[1];
    if (!init) {
      throw new Error("Expected fetch init");
    }
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBe(
      "app_session=app-cookie; api_session=api-cookie",
    );
    expect(headers.get("authorization")).toBe("Bearer desktop-token");
    expect(headers.get(CLIENT_VERSION_HEADER)).toBe("1.2.3");
    expect(headers.get(CLIENT_TYPE_HEADER)).toBe(CLIENT_TYPE_DESKTOP);
    expect(headers.get(CLIENT_SESSION_ID_HEADER)).toBe("session-id");
    expect(headers.get(CLIENT_REQUEST_ID_HEADER)).toBe("request-id-1");
  });

  it("refreshes the desktop auth token and retries once on 401", async () => {
    const session: DesktopSessionCookieSource = {
      cookies: {
        async get() {
          return [];
        },
      },
    };
    const cachedToken = "stale-token";
    const refreshAuthToken = vi.fn(
      (options?: { readonly forceRefresh?: boolean }) => {
        expect(options?.forceRefresh).toBe(true);
        return "fresh-token";
      },
    );
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        return fetchMock.mock.calls.length === 1
          ? new Response(null, { status: 401 })
          : jsonResponse({});
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessionFetch = createDesktopComputerUseSessionFetch({
      platformUrl: new URL("https://app.vm0.ai"),
      session,
      addClientHeaders: createDesktopClientHeaderInjector({
        clientVersion: "1.2.3",
        createUuid: uuidSequence("session-id", "request-id-1", "request-id-2"),
      }),
      getCachedAuthToken: () => {
        return cachedToken;
      },
      getAuthToken: refreshAuthToken,
    });
    await sessionFetch("https://api.vm0.ai/api/auth/me");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshAuthToken).toHaveBeenCalledOnce();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer stale-token");
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer fresh-token");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        CLIENT_SESSION_ID_HEADER,
      ),
    ).toBe("session-id");
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
        CLIENT_SESSION_ID_HEADER,
      ),
    ).toBe("session-id");
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get(
        CLIENT_REQUEST_ID_HEADER,
      ),
    ).toBe("request-id-1");
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
        CLIENT_REQUEST_ID_HEADER,
      ),
    ).toBe("request-id-2");
  });

  it("uses cookies without refreshing auth when the first request succeeds", async () => {
    const session: DesktopSessionCookieSource = {
      cookies: {
        async get() {
          return [{ name: "session", value: "cookie-session" }];
        },
      },
    };
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        return jsonResponse({});
      },
    );
    const refreshAuthToken = vi.fn(async () => "fresh-token");
    vi.stubGlobal("fetch", fetchMock);

    const sessionFetch = createDesktopComputerUseSessionFetch({
      platformUrl: new URL("https://app.vm0.ai"),
      session,
      addClientHeaders: noopAddClientHeaders,
      getCachedAuthToken: () => null,
      getAuthToken: refreshAuthToken,
    });
    await sessionFetch("https://api.vm0.ai/api/auth/me");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(refreshAuthToken).not.toHaveBeenCalled();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("cookie")).toBe("session=cookie-session");
    expect(headers.has("authorization")).toBe(false);
  });

  it("returns the first 401 when token refresh cannot produce a token", async () => {
    const session: DesktopSessionCookieSource = {
      cookies: {
        async get() {
          return [];
        },
      },
    };
    const fetchMock = vi.fn(
      async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        return new Response(null, { status: 401 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const sessionFetch = createDesktopComputerUseSessionFetch({
      platformUrl: new URL("https://app.vm0.ai"),
      session,
      addClientHeaders: noopAddClientHeaders,
      getCachedAuthToken: () => null,
      getAuthToken: () => null,
    });
    const response = await sessionFetch("https://api.vm0.ai/api/auth/me");

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
