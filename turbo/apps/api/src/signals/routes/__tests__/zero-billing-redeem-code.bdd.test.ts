import { randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for redeeming a billing code. The redeem is fulfilled
// by the external Atom service (reached over HTTP with a Clerk M2M token), so
// Atom is mocked with MSW and the M2M minting through the Clerk mock; the
// configuration is driven by env stubs. Every assertion reads the real response
// or the external Atom request. See `api.bdd.md` (CHAIN-BILLING-REDEEM-CODE).
const context = testContext();

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";
const CONSUME_URL = `${ATOM_URL}/api/redeem-codes/consume`;

function configureAtom(): void {
  mockOptionalEnv("ATOM_URL", ATOM_URL);
  mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
  context.mocks.clerk.m2m.createToken.mockResolvedValue({
    token: ATOM_M2M_TOKEN,
  });
}

function mockAtomConsume(responder: () => Response): {
  readonly called: () => boolean;
} {
  let called = false;
  server.use(
    http.post(CONSUME_URL, () => {
      called = true;
      return responder();
    }),
  );
  return {
    called: () => {
      return called;
    },
  };
}

describe("billing redeem code (API-first BDD)", () => {
  it("redeems a code through Atom with a trimmed code and the org id", async () => {
    const api = createBddApi(context);
    configureAtom();
    const admin = api.actAsAdmin();

    let requestedAuthorization: string | null = null;
    let requestedBody: unknown = null;
    server.use(
      http.post(CONSUME_URL, async ({ request }) => {
        requestedAuthorization = request.headers.get("authorization");
        requestedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const response = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: " YUMA-123 " },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ redeemed: true });
    expect(context.mocks.clerk.m2m.createToken).toHaveBeenCalledWith({
      machineSecretKey: ATOM_MACHINE_SECRET_KEY,
      secondsUntilExpiration: 3600,
      minRemainingTtlSeconds: 300,
    });
    expect(requestedAuthorization).toBe(`Bearer ${ATOM_M2M_TOKEN}`);
    expect(requestedBody).toStrictEqual({
      code: "YUMA-123",
      org_id: admin.orgId,
    });
  });

  it("rejects unauthenticated and non-admin callers without touching Atom", async () => {
    const api = createBddApi(context);
    configureAtom();
    const atom = mockAtomConsume(() => {
      return HttpResponse.json({ ok: true });
    });

    const unauthenticated = await accept(
      api.billingRedeemCode.create({
        headers: {},
        body: { code: "YUMA-123" },
      }),
      [401],
    );
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [403],
    );
    expect(member.body).toStrictEqual({
      error: {
        message: "Only org admins can manage billing",
        code: "FORBIDDEN",
      },
    });

    expect(atom.called()).toBeFalsy();
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
  });

  it("returns 503 when the redeem service or its auth is unavailable", async () => {
    const api = createBddApi(context);

    // ATOM_URL not configured (in production it has no default).
    configureAtom();
    mockOptionalEnv("ATOM_URL", undefined);
    mockEnv("ENV", "production");
    api.actAsAdmin();
    const noUrl = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [503],
    );
    expect(noUrl.body.error).toStrictEqual({
      message: "Redeem service not configured",
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();

    // Machine secret not configured.
    configureAtom();
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", undefined);
    api.actAsAdmin();
    const noSecret = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [503],
    );
    expect(noSecret.body.error.message).toBe("Redeem service not configured");

    // M2M minting fails.
    configureAtom();
    context.mocks.clerk.m2m.createToken.mockRejectedValueOnce(
      new Error("M2M unavailable"),
    );
    const atom = mockAtomConsume(() => {
      return HttpResponse.json({ ok: true });
    });
    api.actAsAdmin();
    const authFail = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [503],
    );
    expect(authFail.body.error.message).toBe(
      "Redeem service authentication unavailable",
    );
    expect(atom.called()).toBeFalsy();

    // Atom unreachable.
    configureAtom();
    mockAtomConsume(() => {
      return HttpResponse.error();
    });
    api.actAsAdmin();
    const unreachable = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [503],
    );
    expect(unreachable.body.error.message).toBe("Redeem service unavailable");
  });

  it.each([
    ["a generic 404", { error: "invalid code" }, 404, "Invalid redeem code"],
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
      "an unknown business error",
      { error: { code: "atom_internal_business_error" } },
      400,
      "Redeem code could not be redeemed",
    ],
  ])(
    "maps Atom rejection (%s) to a stable bad-request message",
    async (_caseName, body, status, message) => {
      const api = createBddApi(context);
      configureAtom();
      mockAtomConsume(() => {
        return HttpResponse.json(body, { status });
      });
      api.actAsAdmin();

      const response = await accept(
        api.billingRedeemCode.create({
          headers: SESSION_AUTH,
          body: { code: "YUMA-123" },
        }),
        [400],
      );
      expect(response.body).toStrictEqual({
        error: { message, code: "BAD_REQUEST" },
      });
    },
  );

  it("falls back to a stable message when Atom returns malformed JSON", async () => {
    const api = createBddApi(context);
    configureAtom();
    server.use(
      http.post(CONSUME_URL, () => {
        return new Response("{", {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    api.actAsAdmin();

    const response = await accept(
      api.billingRedeemCode.create({
        headers: SESSION_AUTH,
        body: { code: "YUMA-123" },
      }),
      [400],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Invalid redeem code", code: "BAD_REQUEST" },
    });
  });
});
