import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function expectUnauthorized(body: unknown): void {
  expect(body).toStrictEqual({
    error: {
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    },
  });
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

describe("GET/POST/DELETE /api/zero/feature-switches", () => {
  it("rejects requests without an authenticated organization", async () => {
    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const unauthenticatedGet = await accept(client.get({ headers: {} }), [401]);
    expectUnauthorized(unauthenticatedGet.body);

    const unauthenticatedUpdate = await accept(
      client.update({
        headers: {},
        body: { switches: { dummy: true } },
      }),
      [401],
    );
    expectUnauthorized(unauthenticatedUpdate.body);

    const unauthenticatedDelete = await accept(
      client.delete({ headers: {} }),
      [401],
    );
    expectUnauthorized(unauthenticatedDelete.body);

    mocks.clerk.session(`user_${randomUUID()}`, null);

    const organizationlessGet = await accept(
      client.get({ headers: authHeaders() }),
      [401],
    );
    expectUnauthorized(organizationlessGet.body);

    const organizationlessUpdate = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [401],
    );
    expectUnauthorized(organizationlessUpdate.body);

    const organizationlessDelete = await accept(
      client.delete({ headers: authHeaders() }),
      [401],
    );
    expectUnauthorized(organizationlessDelete.body);
  });

  it("manages feature switch overrides through an API-visible lifecycle", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const initial = await accept(client.get({ headers: authHeaders() }), [200]);
    expect(initial.body).toStrictEqual({ switches: {} });

    const created = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [200],
    );
    expect(created.body).toStrictEqual({ switches: { dummy: true } });

    const afterCreate = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(afterCreate.body).toStrictEqual({ switches: { dummy: true } });

    const merged = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { lab: false } },
      }),
      [200],
    );
    expect(merged.body).toStrictEqual({
      switches: { dummy: true, lab: false },
    });

    const overwritten = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: false } },
      }),
      [200],
    );
    expect(overwritten.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    const afterOverwrite = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(afterOverwrite.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    const deleted = await accept(
      client.delete({ headers: authHeaders() }),
      [200],
    );
    expect(deleted.body).toStrictEqual({ deleted: true });

    const afterDelete = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );
    expect(afterDelete.body).toStrictEqual({ switches: {} });
  });
});
