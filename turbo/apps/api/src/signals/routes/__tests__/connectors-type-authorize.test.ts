import { randomUUID } from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import { createApp } from "../../../app-factory";
import { mockOptionalEnv } from "../../../lib/env";
import { testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const BASE_URL = "https://app.vm0.test";

function authorizeUrl(type: string, session?: string): string {
  const url = new URL(`/api/connectors/${type}/authorize`, BASE_URL);
  if (session) {
    url.searchParams.set("session", session);
  }
  return url.toString();
}

function sessionHeaders(): HeadersInit {
  return { cookie: "__session=opaque" };
}

async function requestAuthorize(
  type: string,
  options: { readonly session?: string; readonly authenticated?: boolean } = {},
): Promise<Response> {
  if (options.authenticated) {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  }
  const app = createApp({ signal: context.signal });
  return await app.request(authorizeUrl(type, options.session), {
    method: "GET",
    headers: options.authenticated ? sessionHeaders() : undefined,
  });
}

describe("GET /api/connectors/:type/authorize", () => {
  beforeEach(() => {
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
  });

  it("returns 400 for an unknown connector type", async () => {
    const response = await requestAuthorize("invalid");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Unknown connector type: invalid",
    });
  });

  it("redirects unauthenticated users to sign-in with the direct route", async () => {
    const response = await requestAuthorize("github");

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(authorizeUrl("github"));
  });

  it("redirects to GitHub OAuth with the direct callback URI", async () => {
    const response = await requestAuthorize("github", { authenticated: true });

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/connectors/github/callback`,
    );
    expect(url.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(
      response.headers.getSetCookie().some((cookie) => {
        return cookie.startsWith("connector_oauth_state=");
      }),
    ).toBeTruthy();
  });
});
