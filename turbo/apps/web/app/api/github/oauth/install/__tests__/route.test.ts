import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { env } from "../../../../../../src/env";

const context = testContext();

describe("/api/github/oauth/install", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("should redirect to GitHub App installation page with signed state", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/github/oauth/install?vm0UserId=user-1&composeId=compose-1",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);

    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe(
      `/apps/${env().GITHUB_APP_SLUG}/installations/new`,
    );

    // Verify redirect_uri derives from request origin
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/github/oauth/callback",
    );

    // Verify state contains signed payload
    const state = JSON.parse(location.searchParams.get("state")!);
    expect(state.vm0UserId).toBe("user-1");
    expect(state.composeId).toBe("compose-1");
    expect(state.sig).toBeDefined();

    // Verify HMAC signature is correct
    const expectedSig = createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
      .update("user-1:compose-1")
      .digest("hex");
    expect(state.sig).toBe(expectedSig);
  });

  it("should redirect without state when no query params provided", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/github/oauth/install",
    );
    const response = await GET(request);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("Location")!);

    expect(location.searchParams.has("state")).toBe(false);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/github/oauth/callback",
    );
  });
});
