import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { GET } from "../route";
import { http } from "../../../../../../../../../src/__tests__/msw";
import { server } from "../../../../../../../../../src/mocks/server";

describe("GET /api/zero/me/model-providers/codex-oauth-token/oauth/authorize", () => {
  it("forwards authorize redirects and OAuth cookies to the api backend", async () => {
    const forwardedUrls: string[] = [];
    const forwardedHeaders: Headers[] = [];
    const handler = http.get(
      "http://localhost:3001/api/zero/me/model-providers/codex-oauth-token/oauth/authorize",
      ({ request }) => {
        forwardedUrls.push(request.url);
        forwardedHeaders.push(request.headers);
        return new HttpResponse(null, {
          status: 307,
          headers: [
            ["location", "https://auth.openai.com/oauth/authorize?state=abc"],
            [
              "set-cookie",
              "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
            ],
            [
              "set-cookie",
              "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
            ],
          ],
        });
      },
    );
    server.use(handler.handler);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/authorize?from=settings",
        {
          method: "GET",
          headers: {
            cookie: "__session=opaque",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://auth.openai.com/oauth/authorize?state=abc",
    );
    expect(forwardedUrls).toStrictEqual([
      "http://localhost:3001/api/zero/me/model-providers/codex-oauth-token/oauth/authorize?from=settings",
    ]);
    expect(forwardedHeaders[0]?.get("cookie")).toBe("__session=opaque");
    expect(forwardedHeaders[0]?.get("x-forwarded-host")).toBe("localhost:3000");
    expect(forwardedHeaders[0]?.get("x-forwarded-proto")).toBe("http");
    expect(response.headers.getSetCookie()).toStrictEqual([
      "model_provider_oauth_state=abc; Max-Age=900; Path=/; HttpOnly",
      "model_provider_oauth_pkce=verifier; Max-Age=900; Path=/; HttpOnly",
    ]);
  });
});
