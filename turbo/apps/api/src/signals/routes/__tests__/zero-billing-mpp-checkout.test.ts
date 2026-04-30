import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { signPatJwtForTests } from "../../auth/tokens";

const ctx = testContext();

function createPatToken(orgId: string, userId: string, tokenId: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return signPatJwtForTests({
    scope: "cli",
    userId,
    orgId,
    tokenId,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
}

function createAppForTest() {
  return createApp({ signal: ctx.signal });
}

describe("GET /api/zero/billing/mpp/checkout", () => {
  it("returns 401 without authorization header", async () => {
    const app = createAppForTest();
    const res = await app.request(
      "/api/zero/billing/mpp/checkout?tier=pro&org=org_test",
      { method: "GET" },
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 when tier is missing", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = createPatToken(orgId, userId, `tok_${randomUUID()}`);

    const app = createAppForTest();
    const res = await app.request(
      `/api/zero/billing/mpp/checkout?org=${orgId}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 400 for unknown tier", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = createPatToken(orgId, userId, `tok_${randomUUID()}`);

    const app = createAppForTest();
    const res = await app.request(
      `/api/zero/billing/mpp/checkout?tier=enterprise&org=${orgId}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(400);
  });

  it("returns 403 when url org does not match token org", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = createPatToken(orgId, userId, `tok_${randomUUID()}`);

    const app = createAppForTest();
    const res = await app.request(
      "/api/zero/billing/mpp/checkout?tier=pro&org=org_different",
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(403);
  });

  it("returns 402 with WWW-Authenticate for valid Bearer request (pro)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = createPatToken(orgId, userId, `tok_${randomUUID()}`);

    const app = createAppForTest();
    const res = await app.request(
      `/api/zero/billing/mpp/checkout?tier=pro&org=${orgId}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(402);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth!.startsWith("Payment ")).toBe(true);
  });

  it("returns 402 with WWW-Authenticate for valid Bearer request (team)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const token = createPatToken(orgId, userId, `tok_${randomUUID()}`);

    const app = createAppForTest();
    const res = await app.request(
      `/api/zero/billing/mpp/checkout?tier=team&org=${orgId}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
    );

    expect(res.status).toBe(402);
  });

  it("returns 400 for phase 2 without org query param", async () => {
    const app = createAppForTest();
    const res = await app.request(
      "/api/zero/billing/mpp/checkout?tier=pro",
      {
        method: "GET",
        headers: { authorization: "Payment invalid-credential" },
      },
    );

    // org query param is required in phase 2 — validated before mppx
    expect(res.status).toBe(400);
  });

  it("returns 402 with fresh challenge for invalid payment credential", async () => {
    const orgId = `org_${randomUUID()}`;

    const app = createAppForTest();
    const res = await app.request(
      `/api/zero/billing/mpp/checkout?tier=pro&org=${orgId}`,
      {
        method: "GET",
        headers: { authorization: "Payment invalid-credential" },
      },
    );

    // mppx rejects invalid credentials with a fresh 402 challenge
    expect(res.status).toBe(402);
    const wwwAuth = res.headers.get("www-authenticate");
    expect(wwwAuth).toBeTruthy();
  });
});
