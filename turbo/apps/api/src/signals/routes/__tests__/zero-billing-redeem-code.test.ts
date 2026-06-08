import { randomUUID } from "node:crypto";

import { zeroBillingRedeemCodeContract } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const ATOM_URL = "https://atom.example.test";
const ATOM_MACHINE_SECRET_KEY = "msk_test_atom";
const ATOM_M2M_TOKEN = "mt_test_atom";

interface SessionFixture {
  readonly userId: string;
  readonly orgId: string;
}

const trackFeatureSwitchOverride = createFixtureTracker<SessionFixture>(
  async (fixture) => {
    const writeDb = store.set(writeDb$);
    await writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, fixture.orgId),
          eq(userFeatureSwitches.userId, fixture.userId),
        ),
      );
  },
);

function setAdminSession(): SessionFixture {
  const fixture = {
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
  return fixture;
}

async function setRedeemCodeSwitch(
  fixture: SessionFixture,
  enabled: boolean,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.OnboardingRedeemCode]: enabled },
  });
  await trackFeatureSwitchOverride(Promise.resolve(fixture));
}

describe("POST /api/zero/billing/redeem-code", () => {
  beforeEach(() => {
    mockOptionalEnv("ATOM_URL", ATOM_URL);
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", ATOM_MACHINE_SECRET_KEY);
    context.mocks.clerk.m2m.createToken.mockResolvedValue({
      token: ATOM_M2M_TOKEN,
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroBillingRedeemCodeContract);

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

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
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
    await setRedeemCodeSwitch(setAdminSession(), true);

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
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
    mockOptionalEnv("VM0_MACHINE_SECRET_KEY", undefined);
    await setRedeemCodeSwitch(setAdminSession(), true);

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
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

  it("returns 403 when the feature switch is disabled", async () => {
    let calledAtom = false;
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        calledAtom = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    await setRedeemCodeSwitch(setAdminSession(), false);

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
    const response = await accept(
      client.create({
        body: { code: "YUMA-123" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Onboarding redeem codes are not enabled",
        code: "FORBIDDEN",
      },
    });
    expect(calledAtom).toBeFalsy();
    expect(context.mocks.clerk.m2m.createToken).not.toHaveBeenCalled();
  });

  it("returns 400 when Atom rejects the redeem code", async () => {
    server.use(
      http.post(`${ATOM_URL}/api/redeem-codes/consume`, () => {
        return HttpResponse.json({ error: "invalid code" }, { status: 404 });
      }),
    );
    await setRedeemCodeSwitch(setAdminSession(), true);

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
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
      await setRedeemCodeSwitch(setAdminSession(), true);

      const client = setupApp({ context })(zeroBillingRedeemCodeContract);
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

  it("redeems a code through Atom", async () => {
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
    await setRedeemCodeSwitch(fixture, true);

    const client = setupApp({ context })(zeroBillingRedeemCodeContract);
    const response = await accept(
      client.create({
        body: { code: " YUMA-123 " },
        headers: { authorization: "Bearer clerk-session" },
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
      org_id: fixture.orgId,
    });
  });
});
