import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { zeroVariablesByNameContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { variables } from "@vm0/db/schema/variable";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherVariable$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/variables/:name", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({ params: { name: "ANY_VAR" }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ANY_VAR" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });
  });

  it("deletes a variable successfully and removes the row", async () => {
    const fixture = await track(
      store.set(
        seedVariables$,
        [{ name: "DELETE_ME", value: "to-be-deleted" }],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await client.delete({
      params: { name: "DELETE_ME" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    // Row removed
    const writeDb = store.set(writeDb$);
    const remaining = await writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.userId, fixture.userId),
          eq(variables.name, "DELETE_ME"),
        ),
      );
    expect(remaining).toStrictEqual([]);
  });

  it("deletes only the user-owned variable when a connector-owned variable has the same name", async () => {
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
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await client.delete({
      params: { name: "SHARED_NAME" },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

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
          eq(variables.name, "SHARED_NAME"),
        ),
      );
    expect(remaining).toStrictEqual([
      { name: "SHARED_NAME", value: "connector-value", type: "connector" },
    ]);
  });

  it("returns 404 when only a connector-owned variable exists", async () => {
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "CONNECTOR_ONLY",
            value: "connector-value",
            type: "connector",
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "CONNECTOR_ONLY" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("returns 404 for a nonexistent variable", async () => {
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "NONEXISTENT" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: 'Variable "NONEXISTENT" not found',
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 for a variable owned by another user (cross-user isolation)", async () => {
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    // Another user in the same org owns OTHER_USER_VAR.
    await store.set(seedOtherVariable$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "OTHER_USER_VAR" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the victim row is still there (not silently deleted).
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, fixture.orgId),
          eq(variables.name, "OTHER_USER_VAR"),
        ),
      );
    expect(victim).toHaveLength(1);
  });

  it("returns 404 for a variable in another org (cross-org isolation)", async () => {
    const orgAFixture = await track(
      store.set(
        seedVariables$,
        [{ name: "ORG_A_VAR", value: "value-a" }],
        context.signal,
      ),
    );

    // Authenticate as a different user in a different org.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroVariablesByNameContract);
    const response = await accept(
      client.delete({
        params: { name: "ORG_A_VAR" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the victim row is still there in org A.
    const writeDb = store.set(writeDb$);
    const victim = await writeDb
      .select({ id: variables.id, orgId: variables.orgId })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, orgAFixture.orgId),
          eq(variables.name, "ORG_A_VAR"),
        ),
      );
    expect(victim).toHaveLength(1);
    expect(victim[0]?.orgId).toBe(orgAFixture.orgId);
  });
});
