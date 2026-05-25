import { describe, expect, it } from "vitest";

import { buildXAuthorizationUrl } from "../x";

describe("buildXAuthorizationUrl", () => {
  it("requests a fresh X login when building the OAuth URL", async () => {
    const authorizationUrl = new URL(
      await buildXAuthorizationUrl(
        "x-client-id",
        "https://app.vm0.ai/api/connectors/x/callback",
        "state-123",
      ),
    );

    expect(`${authorizationUrl.origin}${authorizationUrl.pathname}`).toBe(
      "https://twitter.com/i/oauth2/authorize",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe("x-client-id");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://app.vm0.ai/api/connectors/x/callback",
    );
    expect(authorizationUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("force_login")).toBe("true");
  });
});
