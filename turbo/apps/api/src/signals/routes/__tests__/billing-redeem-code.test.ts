import { createHash, randomUUID } from "node:crypto";

import { EVENT } from "@axiomhq/logging";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createRouteMocks } from "./helpers/route-test";
import {
  billingRedeemCodeRoutes,
  reportMachineSecretAliasSourceAtProcessInitialization,
} from "../billing-redeem-code";

const context = testContext();
const mocks = createRouteMocks(context);

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";
const MACHINE_SECRET_ALIAS_RESOLUTION_EVENT =
  "billing_machine_secret_alias_resolution";
const MACHINE_SECRET_LOG_CONTEXT = "api:zero:billing-redeem-code";

type MachineSecretAliasState =
  | "absent"
  | "canonical-only"
  | "legacy-only"
  | "equal-dual"
  | "conflicting-dual";

interface MachineSecretAliasFixture {
  readonly source: MachineSecretAliasState;
  readonly canonical: string | undefined;
  readonly legacy: string | undefined;
  readonly expectedStatus: 200 | 503;
}

const MACHINE_SECRET_ALIAS_FIXTURES: readonly MachineSecretAliasFixture[] = [
  {
    source: "absent",
    canonical: "",
    legacy: "",
    expectedStatus: 503,
  },
  {
    source: "canonical-only",
    canonical: `canonical-machine-secret-${"c".repeat(113)}`,
    legacy: "",
    expectedStatus: 200,
  },
  {
    source: "legacy-only",
    canonical: "",
    legacy: `legacy-machine-secret-${"l".repeat(127)}`,
    expectedStatus: 200,
  },
  {
    source: "equal-dual",
    canonical: `equal-machine-secret-${"e".repeat(131)}`,
    legacy: `equal-machine-secret-${"e".repeat(131)}`,
    expectedStatus: 200,
  },
  {
    source: "conflicting-dual",
    canonical: `conflicting-canonical-secret-${"x".repeat(137)}`,
    legacy: `conflicting-legacy-secret-${"y".repeat(139)}`,
    expectedStatus: 503,
  },
];

interface SessionFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly email: string;
}

function aliasEvidence(
  source: MachineSecretAliasState,
): Readonly<Record<string, unknown>> {
  return {
    [EVENT]: { source: "api" },
    source,
    context: MACHINE_SECRET_LOG_CONTEXT,
  };
}

function expectValueFree(diagnostics: string, values: readonly string[]): void {
  for (const value of values) {
    const forbiddenDerivatives = [
      value,
      String(value.length),
      createHash("sha256").update(value).digest("hex"),
      JSON.stringify(value),
    ];
    for (const derivative of forbiddenDerivatives) {
      expect(diagnostics).not.toContain(derivative);
    }
  }
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

  it("reports every machine secret source at initialization once per process without exposing values", async () => {
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json({ ok: true });
      }),
    );
    const client = setupApp({ context, routes: billingRedeemCodeRoutes })(
      billingRedeemCodeContract,
    );

    for (const fixture of MACHINE_SECRET_ALIAS_FIXTURES) {
      mockOptionalEnv("OKOU_MACHINE_SECRET_KEY", fixture.canonical);
      mockOptionalEnv("VM0_MACHINE_SECRET_KEY", fixture.legacy);
      setAdminSession();
      const infoLogCount = context.mocks.axiomLogging.info.mock.calls.filter(
        ([message]) => {
          return message === MACHINE_SECRET_ALIAS_RESOLUTION_EVENT;
        },
      ).length;
      const warnLogCount = context.mocks.axiomLogging.warn.mock.calls.filter(
        ([message]) => {
          return message === MACHINE_SECRET_ALIAS_RESOLUTION_EVENT;
        },
      ).length;

      reportMachineSecretAliasSourceAtProcessInitialization();
      reportMachineSecretAliasSourceAtProcessInitialization();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await accept(
          client.create({
            body: { code: `YUMA-${fixture.source}-${attempt}` },
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200, 503],
        );
        expect(response.status).toBe(fixture.expectedStatus);
      }

      const infoCalls = context.mocks.axiomLogging.info.mock.calls
        .filter(([message]) => {
          return message === MACHINE_SECRET_ALIAS_RESOLUTION_EVENT;
        })
        .slice(infoLogCount);
      const warnCalls = context.mocks.axiomLogging.warn.mock.calls
        .filter(([message]) => {
          return message === MACHINE_SECRET_ALIAS_RESOLUTION_EVENT;
        })
        .slice(warnLogCount);
      const expectedCall = [
        MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
        aliasEvidence(fixture.source),
      ];
      const expectedInfoCalls =
        fixture.source === "conflicting-dual" ? [] : [expectedCall];
      const expectedWarnCalls =
        fixture.source === "conflicting-dual" ? [expectedCall] : [];
      expect(infoCalls).toStrictEqual(expectedInfoCalls);
      expect(warnCalls).toStrictEqual(expectedWarnCalls);
      expectValueFree(
        JSON.stringify({ infoCalls, warnCalls }),
        [fixture.canonical, fixture.legacy].filter((value): value is string => {
          return Boolean(value);
        }),
      );
    }

    expect(context.mocks.axiomLogging.debug).not.toHaveBeenCalledWith(
      MACHINE_SECRET_ALIAS_RESOLUTION_EVENT,
      expect.anything(),
    );
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
    "redeems a code with $source machine secret configuration after startup observation",
    async ({ canonical, legacy, expected }) => {
      reportMachineSecretAliasSourceAtProcessInitialization();
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
    },
  );
});
