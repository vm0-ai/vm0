import { randomUUID } from "node:crypto";

import { zeroBillingRedeemCodeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-billing-redeem-code.test.ts`. The 13 legacy `it()`s
// (incl. an `it.each` for 4 cases) collapse into 3 BDD
// `it()`s: (1) auth chain (401 unauth → 403 non-admin +
// Atom not called + M2M token not called), (2) 503/400
// provider chain (503 no ATOM_URL → 503 no M2M secret → 503
// M2M auth fails + Atom not called → 503 Atom unreachable →
// 400 Atom rejects the code), (3) error matrix chain (it.each
// 4 cases: already used 409, expired 410, not eligible 403,
// unknown 400) → 400 malformed JSON fallback → 200 happy path
// with body trimming + Atom called once with the trimmed code
// + the M2M token + Clerk M2M called with the expected args).
//
// Service-Level Exception: the upstream Atom redeem endpoint
// is mocked via MSW. The M2M token mint is mocked via
// `context.mocks.clerk.m2m.createToken`. Both mocks are
// shared across chain steps and asserted with
// `toHaveBeenCalledTimes` to track exact invocation counts.

const context = testContext();
const mocks = createZeroRouteMocks(context);

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";

interface SessionFixture {
  readonly userId: string;
  readonly orgId: string;
}

function setAdminSession(): SessionFixture {
  const fixture = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  return fixture;
}

function resetMocksAndEnv(): void {
  mockOptionalEnv("ATOM_URL", ATOM_URL);
  mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
  mockOptionalEnv("ENV", undefined);
  context.mocks.clerk.m2m.createToken.mockReset();
  context.mocks.clerk.m2m.createToken.mockResolvedValue({
    token: ATOM_M2M_TOKEN,
  });
  server.resetHandlers();
}

function client() {
  return setupApp({ context })(zeroBillingRedeemCodeContract);
}

describe("BDD POST /api/zero/billing/redeem-code — auth chain", () => {
  it("gwt-wt-wt: 401 unauth → 403 non-admin (Atom not called, M2M token not minted)", async () => {
    resetMocksAndEnv();
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    // Given: a non-admin session.
    let calledAtom = false;
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        calledAtom = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );

    // When + Then: 403 — non-admin cannot redeem; Atom is
    // not called and the M2M token is not minted.
    const nonAdmin = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(nonAdmin.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
    expect(calledAtom).toBeFalsy();
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledTimes(0);
  });
});

describe("BDD POST /api/zero/billing/redeem-code — provider error chain", () => {
  it("gwt-wt-wt: 503 no ATOM_URL → 503 no M2M secret → 503 M2M auth fails (Atom not called) → 503 Atom unreachable → 400 Atom rejects the code", async () => {
    const c = client();

    // Given: ATOM_URL is cleared, ENV=production so the
    // "ignored in production" guard is exercised.
    mockOptionalEnv("ATOM_URL", undefined);
    mockEnv("ENV", "production");
    setAdminSession();

    // When + Then: 503 — ATOM_URL missing.
    const noAtom = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(noAtom.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledTimes(0);

    // Given: ATOM_URL back, but M2M secret cleared.
    mockOptionalEnv("ATOM_URL", ATOM_URL);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", undefined);
    setAdminSession();

    // When + Then: 503 — M2M secret missing.
    const noM2m = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(noM2m.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledTimes(0);

    // Given: M2M auth fails on the next mint.
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
    let calledAtom = false;
    server.resetHandlers();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        calledAtom = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    context.mocks.clerk.m2m.createToken.mockReset();
    context.mocks.clerk.m2m.createToken.mockRejectedValueOnce(
      new Error("M2M unavailable"),
    );
    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: ATOM_M2M_TOKEN,
    });
    setAdminSession();

    // When + Then: 503 — M2M auth failed; Atom is not
    // called.
    const m2mFailed = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(m2mFailed.body).toStrictEqual({
      error: {
        message: "Redeem service authentication unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(calledAtom).toBeFalsy();
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledTimes(1);

    // Given: M2M back to resolving, Atom unreachable.
    server.resetHandlers();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.error();
      }),
    );
    setAdminSession();

    // When + Then: 503 — Atom unreachable.
    const unreachable = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );
    expect(unreachable.body).toStrictEqual({
      error: {
        message: "Redeem service unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });

    // Given: Atom returns 404 + invalid code body.
    server.resetHandlers();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json({ error: "invalid code" }, { status: 404 });
      }),
    );
    setAdminSession();

    // When + Then: 400 — Atom rejects the code.
    const rejected = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(rejected.body).toStrictEqual({
      error: {
        message: "Invalid redeem code",
        code: "BAD_REQUEST",
      },
    });
  });
});

describe("BDD POST /api/zero/billing/redeem-code — error matrix + happy path", () => {
  it("gwt-wt-wt: error matrix (already used 409, expired 410, not eligible 403, unknown 400) → 400 malformed JSON fallback → 200 happy path (trimmed code, M2M token, expected args)", async () => {
    const c = client();

    // Given: an admin session + an Atom that reports an
    // "already used" business error.
    resetMocksAndEnv();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json(
          { error: { code: "already_used" } },
          { status: 409 },
        );
      }),
    );
    setAdminSession();

    // When + Then: 400 with a stable message.
    const alreadyUsed = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(alreadyUsed.body).toStrictEqual({
      error: {
        message: "This redeem code has already been used",
        code: "BAD_REQUEST",
      },
    });

    // Given: Atom reports an expired code.
    resetMocksAndEnv();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json(
          { error_code: "code_expired" },
          { status: 410 },
        );
      }),
    );
    setAdminSession();

    // When + Then: 400 with the expired message.
    const expired = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "This redeem code has expired",
        code: "BAD_REQUEST",
      },
    });

    // Given: Atom reports an org-mismatch.
    resetMocksAndEnv();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json({ code: "org_mismatch" }, { status: 403 });
      }),
    );
    setAdminSession();

    // When + Then: 400 with the not-eligible message.
    const notEligible = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(notEligible.body).toStrictEqual({
      error: {
        message: "This code is not eligible for this workspace",
        code: "BAD_REQUEST",
      },
    });

    // Given: Atom reports an internal business error.
    resetMocksAndEnv();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json(
          { error: { code: "atom_internal_business_error" } },
          { status: 400 },
        );
      }),
    );
    setAdminSession();

    // When + Then: 400 with the unknown-error message.
    const unknown = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(unknown.body).toStrictEqual({
      error: {
        message: "Redeem code could not be redeemed",
        code: "BAD_REQUEST",
      },
    });

    // Given: Atom returns malformed JSON.
    resetMocksAndEnv();
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return new Response("{", {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    setAdminSession();

    // When + Then: 400 — falls back to the "Invalid redeem
    // code" message.
    const malformed = await accept(
      c.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(malformed.body).toStrictEqual({
      error: {
        message: "Invalid redeem code",
        code: "BAD_REQUEST",
      },
    });

    // Given: a fresh admin + Atom that captures the request.
    resetMocksAndEnv();
    const fixture = setAdminSession();
    let requestedBody: unknown = null;
    let requestedAuthorization: string | null = null;
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, async ({ request }) => {
        requestedAuthorization = request.headers.get("authorization");
        requestedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    // When: redeem a code with surrounding whitespace.
    const redeemed = await accept(
      c.create({
        body: { code: " YUMA-123 " },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    // Then: 200 + the M2M token was minted with the expected
    // args + Atom was called once with the trimmed code and
    // the org id, with the M2M bearer token.
    expect(redeemed.body).toStrictEqual({ redeemed: true });
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledWith({
      machineSecretKey: ATOM_MACHINE_SECRET_KEY,
      secondsUntilExpiration: 3600,
      minRemainingTtlSeconds: 300,
    });
    expect(requestedAuthorization).toBe(`Bearer ${ATOM_M2M_TOKEN}`);
    expect(requestedBody).toStrictEqual({
      code: "YUMA-123",
      org_id: fixture.orgId,
    });
  });
});
