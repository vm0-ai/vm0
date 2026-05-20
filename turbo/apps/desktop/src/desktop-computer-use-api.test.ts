import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopComputerUseSessionFetch } from "./desktop-computer-use-api";
import type { DesktopSessionCookieSource } from "./desktop-session-cookies";

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
    });
    await sessionFetch("https://api.vm0.ai/api/zero/computer-use/hosts/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
