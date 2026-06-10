import { randomUUID } from "node:crypto";

import { zeroBillingRedeemCodeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";

interface SessionFixture {
  readonly userId: string;
  readonly orgId: string;
}

interface AtomMock {
  readonly callCount: () => number;
  readonly requestedBody: () => unknown;
  readonly requestedAuthorization: () => string | null;
}

function setAdminSession(): SessionFixture {
  const fixture = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  return fixture;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroBillingRedeemCodeContract);
}

function postRedeem(code = "YUMA-123") {
  return apiClient().create({
    body: { code },
    headers: authHeaders(),
  });
}

function mockAtomConsume(
  handler: (request: Request) => Promise<Response> | Response,
): AtomMock {
  let calls = 0;
  let requestedBody: unknown = null;
  let requestedAuthorization: string | null = null;

  server.use(
    http.post(`${ATOM_URL}/api/redeem-codes/consume`, async ({ request }) => {
      calls++;
      requestedAuthorization = request.headers.get("authorization");
      requestedBody = await request
        .clone()
        .json()
        .catch(() => {
          return null;
        });
      return await handler(request);
    }),
  );

  return {
    callCount: () => {
      return calls;
    },
    requestedBody: () => {
      return requestedBody;
    },
    requestedAuthorization: () => {
      return requestedAuthorization;
    },
  };
}

describe("POST /api/zero/billing/redeem-code BDD", () => {
  beforeEach(() => {
    mockEnv("ENV", "development");
    mockOptionalEnv("ATOM_URL", ATOM_URL);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: ATOM_M2M_TOKEN,
    });
  });

  it("rejects unauthenticated, unauthorized, and unconfigured requests before Atom redemption", async () => {
    const client = apiClient();

    const unauthenticated = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    const atomForMember = mockAtomConsume(() => {
      return HttpResponse.json({ ok: true });
    });
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID()}`,
      "org:member",
    );
    const forbidden = await accept(postRedeem(), [403]);

    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });
    expect(atomForMember.callCount()).toBe(0);
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();

    mockOptionalEnv("ATOM_URL", undefined);
    mockEnv("ENV", "production");
    setAdminSession();
    const missingAtomUrl = await accept(postRedeem(), [503]);

    expect(missingAtomUrl.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();

    mockEnv("ENV", "development");
    mockOptionalEnv("ATOM_URL", ATOM_URL);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", undefined);
    setAdminSession();
    const missingM2m = await accept(postRedeem(), [503]);

    expect(missingM2m.body).toStrictEqual({
      error: {
        message: "Redeem service not configured",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();

    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
    context.mocks.clerk.m2m.createToken.mockRejectedValueOnce(
      new Error("M2M unavailable"),
    );
    const atomForM2mFailure = mockAtomConsume(() => {
      return HttpResponse.json({ ok: true });
    });
    setAdminSession();
    const failedM2m = await accept(postRedeem(), [503]);

    expect(failedM2m.body).toStrictEqual({
      error: {
        message: "Redeem service authentication unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
    expect(atomForM2mFailure.callCount()).toBe(0);

    mockAtomConsume(() => {
      return HttpResponse.error();
    });
    setAdminSession();
    const atomUnavailable = await accept(postRedeem(), [503]);

    expect(atomUnavailable.body).toStrictEqual({
      error: {
        message: "Redeem service unavailable",
        code: "PROVIDER_UNAVAILABLE",
      },
    });
  });

  it("maps Atom redeem failures to stable API errors", async () => {
    const cases = [
      {
        name: "invalid code",
        body: { error: "invalid code" },
        status: 404,
        message: "Invalid redeem code",
      },
      {
        name: "already used",
        body: { error: { code: "already_used" } },
        status: 409,
        message: "This redeem code has already been used",
      },
      {
        name: "expired",
        body: { error_code: "code_expired" },
        status: 410,
        message: "This redeem code has expired",
      },
      {
        name: "not eligible",
        body: { code: "org_mismatch" },
        status: 403,
        message: "This code is not eligible for this workspace",
      },
      {
        name: "unknown",
        body: { error: { code: "atom_internal_business_error" } },
        status: 400,
        message: "Redeem code could not be redeemed",
      },
    ] as const;

    for (const testCase of cases) {
      mockAtomConsume(() => {
        return HttpResponse.json(testCase.body, { status: testCase.status });
      });
      setAdminSession();

      const response = await accept(postRedeem(), [400]);

      expect(response.body).toStrictEqual({
        error: {
          message: testCase.message,
          code: "BAD_REQUEST",
        },
      });
    }

    mockAtomConsume(() => {
      return new Response("{", {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    setAdminSession();
    const malformedJson = await accept(postRedeem(), [400]);

    expect(malformedJson.body).toStrictEqual({
      error: {
        message: "Invalid redeem code",
        code: "BAD_REQUEST",
      },
    });
  });

  it("redeems a code through Atom", async () => {
    const fixture = setAdminSession();
    const atom = mockAtomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    const response = await accept(postRedeem(" YUMA-123 "), [200]);

    expect(response.body).toStrictEqual({ redeemed: true });
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledWith({
      machineSecretKey: ATOM_MACHINE_SECRET_KEY,
      secondsUntilExpiration: 3600,
      minRemainingTtlSeconds: 300,
    });
    expect(atom.requestedAuthorization()).toBe(`Bearer ${ATOM_M2M_TOKEN}`);
    expect(atom.requestedBody()).toStrictEqual({
      code: "YUMA-123",
      org_id: fixture.orgId,
    });
  });
});
