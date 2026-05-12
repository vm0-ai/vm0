import { describe, expect, it } from "vitest";
import { HttpResponse } from "msw";

import { GET } from "../route";
import { http } from "../../../../../../../../../src/__tests__/msw";
import { server } from "../../../../../../../../../src/mocks/server";

describe("GET /api/zero/me/model-providers/codex-oauth-token/oauth/callback", () => {
  it("forwards callback redirects and cleared OAuth cookies to the api backend", async () => {
    const forwardedUrls: string[] = [];
    const forwardedHeaders: Headers[] = [];
    const handler = http.get(
      "http://localhost:3001/api/zero/me/model-providers/codex-oauth-token/oauth/callback",
      ({ request }) => {
        forwardedUrls.push(request.url);
        forwardedHeaders.push(request.headers);
        return new HttpResponse(null, {
          status: 307,
          headers: [
            [
              "location",
              "http://localhost:3000/connector/success?type=openai&username=Personal+Workspace",
            ],
            ["set-cookie", "model_provider_oauth_state=; Max-Age=0; Path=/"],
            ["set-cookie", "model_provider_oauth_pkce=; Max-Age=0; Path=/"],
          ],
        });
      },
    );
    server.use(handler.handler);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/zero/me/model-providers/codex-oauth-token/oauth/callback?code=code-1&state=state-1",
        {
          method: "GET",
          headers: {
            cookie:
              "model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
          },
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/connector/success?type=openai&username=Personal+Workspace",
    );
    expect(forwardedUrls).toStrictEqual([
      "http://localhost:3001/api/zero/me/model-providers/codex-oauth-token/oauth/callback?code=code-1&state=state-1",
    ]);
    expect(forwardedHeaders[0]?.get("cookie")).toBe(
      "model_provider_oauth_state=state-1; model_provider_oauth_pkce=verifier-1",
    );
    expect(forwardedHeaders[0]?.get("x-forwarded-host")).toBe("localhost:3000");
    expect(forwardedHeaders[0]?.get("x-forwarded-proto")).toBe("http");
    expect(response.headers.getSetCookie()).toStrictEqual([
      "model_provider_oauth_state=; Max-Age=0; Path=/",
      "model_provider_oauth_pkce=; Max-Age=0; Path=/",
    ]);
  });
});
