import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

function apiClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("/api/zero/feature-switches BDD", () => {
  it("requires authentication and an active organization for all methods", async () => {
    const client = apiClient();

    const getUnauthenticated = await accept(client.get({ headers: {} }), [401]);
    const updateUnauthenticated = await accept(
      client.update({
        headers: {},
        body: { switches: { dummy: true } },
      }),
      [401],
    );
    const deleteUnauthenticated = await accept(
      client.delete({ headers: {} }),
      [401],
    );

    expect(getUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(updateUnauthenticated.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const getNoOrg = await accept(
      client.get({ headers: authHeaders() }),
      [401],
    );
    const updateNoOrg = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [401],
    );
    const deleteNoOrg = await accept(
      client.delete({ headers: authHeaders() }),
      [401],
    );

    expect(getNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(updateNoOrg.body.error.code).toBe("UNAUTHORIZED");
    expect(deleteNoOrg.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates, merges, overrides, reads, and clears feature switch overrides", async () => {
    const client = apiClient();
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const defaults = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(defaults.body).toStrictEqual({ switches: {} });

    const created = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: true } },
      }),
      [200],
    );

    expect(created.body).toStrictEqual({ switches: { dummy: true } });

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

    const overridden = await accept(
      client.update({
        headers: authHeaders(),
        body: { switches: { dummy: false } },
      }),
      [200],
    );

    expect(overridden.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    const readBack = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(readBack.body).toStrictEqual({
      switches: { dummy: false, lab: false },
    });

    const deleted = await accept(
      client.delete({ headers: authHeaders() }),
      [200],
    );
    const afterDelete = await accept(
      client.get({ headers: authHeaders() }),
      [200],
    );

    expect(deleted.body).toStrictEqual({ deleted: true });
    expect(afterDelete.body).toStrictEqual({ switches: {} });
  });
});
