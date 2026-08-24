import { randomUUID } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createRouteMocks } from "./helpers/route-test";
import { billingRedeemCodeRoutes } from "../billing-redeem-code";

const context = testContext();
const mocks = createRouteMocks(context);

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";
const MACHINE_SECRET_ALIAS_RESOLUTION_EVENT =
  "billing_machine_secret_alias_resolution";
const MACHINE_SECRET_LOG_CONTEXT = "api:zero:billing-redeem-code";

interface SessionFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}

function setAdminSession(): SessionFixture {
  const userId = `user_${randomUUID()}`;
  const fixture = {
    userId,
    orgId: `org_${randomUUID()}`,
    email: `${userId}@example.test`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [
      {
        id: fixture.userId,
        primaryEmailAddressId: `email_${fixture.userId}`,
        emailAddresses: [
          {
            id: `email_${fixture.userId}`,
            emailAddress: fixture.email,
          },
        ],
      },
    ],
  });
  return fixture;
}

describe("POST /api/billing/redeem-code", () => {
  beforeEach(() => {
    mockOptionalEnv("ATOM_URL", ATOM_URL);
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", undefined);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: ATOM_M2M_TOKEN,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );

    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 403 for a non-admin org member", async () => {
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

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
    expect(calledAtom).toBeFalsy();
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
  });

  it("returns 503 when ATOM_URL is not configured", async () => {
    mockOptionalEnv("ATOM_URL", undefined);
    mockEnv("ENV", "production");
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
  });

  it("returns 503 when Atom Clerk M2M auth is not configured", async () => {
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", undefined);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", undefined);
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
    expect(context.mocks.axiomLogging.warn).not.toHaveBeenCalledWith(
      MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
  });

  it("fails closed when Atom Clerk M2M auth aliases conflict", async () => {
    const canonicalSecret = "canonical-secret-must-not-leak";
    const legacySecret = "legacy-secret-must-not-leak";
    mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", canonicalSecret);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", legacySecret);
    setAdminSession();
    let calledAtom = false;
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        calledAtom = true;
        return HttpResponse.json({ ok: true });
      }),
    );

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
    expect(calledAtom).toBeFalsy();
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledTimes(1);
    expect(context.mocks.axiomLogging.warn).toHaveBeenCalledWith(
      MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
      {
        [EVENT]: { source: "api" },
        source: "conflicting-dual",
        context: MACHINE_SECRET_LOG_CONTEXT,
      },
    );
    const warningLog = JSON.stringify(
      context.mocks.axiomLogging.warn.mock.calls,
    );
    expect(warningLog).not.toContain(canonicalSecret);
    expect(warningLog).not.toContain(legacySecret);
  });

  it("returns 503 when Atom Clerk M2M auth fails", async () => {
    let calledAtom = false;
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        calledAtom = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    context.mocks.clerk.m2m.createToken.mockRejectedValueOnce(
      new Error("M2M unavailable"),
    );
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Redeem service authentication unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(calledAtom).toBeFalsy();
  });

  it("returns 503 when Atom cannot be reached", async () => {
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.error();
      }),
    );
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [503],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Redeem service unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("returns 400 when Atom rejects the redeem code", async () => {
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json({ error: "invalid code" }, { status: 404 });
      }),
    );
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid redeem code",
        code: "BAD_REQUEST",
      },
    });
  });

  it.each([
    [
      "already used",
      { error: { code: "already_used" } },
      409,
      "This redeem code has already been used",
    ],
    [
      "expired",
      { error_code: "code_expired" },
      410,
      "This redeem code has expired",
    ],
    [
      "not eligible",
      { code: "org_mismatch" },
      403,
      "This code is not eligible for this workspace",
    ],
    [
      "unknown",
      { error: { code: "atom_internal_business_error" } },
      400,
      "Redeem code could not be redeemed",
    ],
  ])(
    "returns a stable message when Atom reports %s",
    async (_caseName, body, status, message) => {
      server.use(
        http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
          return HttpResponse.json(body, { status });
        }),
      );
      setAdminSession();

      const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
        billingRedeemCodeContract,
      );
      const response = await accept(
        client.create({
          body: { code: "YUMA-123" },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [400],
      );

      expect(response.body).toStrictEqual({
        error: {
          message,
          code: "BAD_REQUEST",
        },
      });
    },
  );

  it("falls back to the status message when Atom returns malformed JSON", async () => {
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return new Response("{", {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    setAdminSession();

    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid redeem code",
        code: "BAD_REQUEST",
      },
    });
  });

  it.each([
    {
      source: "canonical-only",
      canonical: "msk_test_atom_canonical",
      legacy: undefined,
      expected: "msk_test_atom_canonical",
    },
    {
      source: "legacy-only",
      canonical: undefined,
      legacy: "msk_test_atom_legacy",
      expected: "msk_test_atom_legacy",
    },
    {
      source: "equal-dual",
      canonical: "msk_test_atom_equal_dual",
      legacy: "msk_test_atom_equal_dual",
      expected: "msk_test_atom_equal_dual",
    },
  ])(
    "redeems a code with $source machine secret configuration",
    async ({ source, canonical, legacy, expected }) => {
      mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", canonical);
      mockOptionalEnv("VM0_MACHINE_SECRET_KEY", legacy);
      const fixture = setAdminSession();
      let requestedBody: unknown = null;
      let requestedAuthorization: string | null = null;
      server.use(
        http.post(
          `${ATOM_URL}/api/redeem-codes/consume`,
          async ({ request }) => {
            requestedAuthorization = request.headers.get("authorization");
            requestedBody = await request.json();
            return HttpResponse.json({ ok: true });
          },
        ),
      );

      const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
        billingRedeemCodeContract,
      );
      const response = await accept(
        client.create({
          body: { code: " YUMA-123 " },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );

      expect(response.body).toStrictEqual({ redeemed: true });
      expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledWith({
        machineSecretKey: expected,
        secondsUntilExpiration: 3600,
        minRemainingTtlSeconds: 300,
      });
      expect(requestedAuthorization).toBe(`Bearer ${ATOM_M2M_TOKEN}`);
      expect(requestedBody).toStrictEqual({
        code: "YUMA-123",
        email: fixture.email,
        org_id: fixture.orgId,
        user_id: fixture.userId,
      });
      const expectedAliasLogs =
        source === "legacy-only"
          ? [
              [
                MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
                {
                  [EVENT]: { source: "api" },
                  source: "legacy-only",
                  context: MACHINE_SECRET_LOG_CONTEXT,
                },
              ],
            ]
          : [];
      expect(context.mocks.axiomLogging.debug.mock.calls).toStrictEqual(
        expectedAliasLogs,
      );
    },
  );
});
