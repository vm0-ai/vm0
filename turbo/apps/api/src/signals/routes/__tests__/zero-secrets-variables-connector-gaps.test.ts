import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedSecrets$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const track = createFixtureTracker<UserDataFixture>((fixture) => {
  return store.set(deleteUserData$, fixture, context.signal);
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

describe("connector-owned zero secrets and variables helper gaps", () => {
  it("keeps connector-owned variables hidden from the user variable list", async () => {
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          { name: "USER_VISIBLE", value: "user-value" },
          {
            name: "CONNECTOR_INTERNAL",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesContract);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.variables).toMatchObject([
      { name: "USER_VISIBLE", value: "user-value" },
    ]);
  });

  it("does not delete connector-owned variables through the user variable delete route", async () => {
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          { name: "SHARED_NAME", value: "user-value" },
          {
            name: "SHARED_NAME",
            value: "connector-value",
            type: "connector",
          },
          {
            name: "CONNECTOR_ONLY",
            value: "connector-only",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const sharedDelete = await client.delete({
      params: { name: "SHARED_NAME" },
      headers: authHeaders(),
    });
    const connectorOnlyDelete = await accept(
      client.delete({
        params: { name: "CONNECTOR_ONLY" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(sharedDelete.status).toBe(204);
    expect(connectorOnlyDelete.body.error.code).toBe("NOT_FOUND");

    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({
        name: variables.name,
        value: variables.value,
        type: variables.type,
      })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
        ),
      )
      .orderBy(variables.name, variables.type);

    expect(remaining).toStrictEqual([
      {
        name: "CONNECTOR_ONLY",
        value: "connector-only",
        type: "connector",
      },
      {
        name: "SHARED_NAME",
        value: "connector-value",
        type: "connector",
      },
    ]);
  });

  it("includes connector-owned secret metadata in the user secret list", async () => {
    const fixture = await track(
      store.set(
        seedSecrets$,
        [
          {
            name: "Z_TOKEN",
            description: null,
            type: "connector",
          },
          {
            name: "A_TOKEN",
            description: "alpha",
            type: "user",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.secrets).toMatchObject([
      {
        name: "A_TOKEN",
        description: "alpha",
        type: "user",
      },
      {
        name: "Z_TOKEN",
        description: null,
        type: "connector",
      },
    ]);
    for (const secret of response.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }
  });

  it("does not delete connector-owned secrets through the user secret delete route", async () => {
    const fixture = await track(
      store.set(
        seedSecrets$,
        [{ name: "CONNECTOR_SECRET", type: "connector" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "CONNECTOR_SECRET" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");

    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: secrets.id, type: secrets.type })
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, fixture.orgId),
          eq(secrets.userId, fixture.userId),
          eq(secrets.name, "CONNECTOR_SECRET"),
        ),
      );

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.type).toBe("connector");
  });
});
