import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { zeroCustomConnectorSecretContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("DELETE /api/zero/custom-connectors/:id/secret", () => {
  const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
    return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 401 when the user has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toMatchObject({ error: {} });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("clears the caller's secret on success (DB read-after-write)", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, { withSecret: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.delete({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select()
      .from(orgCustomConnectorSecrets)
      .where(
        and(
          eq(orgCustomConnectorSecrets.connectorId, fixture.connectorId),
          eq(orgCustomConnectorSecrets.userId, fixture.userId),
        ),
      );
    expect(rows).toHaveLength(0);

    // Parity with web: no realtime publish on secret-clear.
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("is idempotent — second delete still 204 and changes nothing", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    for (let i = 0; i < 2; i++) {
      const response = await accept(
        client.delete({
          params: { id: fixture.connectorId },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [204],
      );
      expect(response.body).toBeUndefined();
    }

    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select()
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, fixture.connectorId));
    expect(rows).toHaveLength(0);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("does not leak across users sharing a connector", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, { withSecret: true }, context.signal),
    );
    // Seed a second user's secret on the same connector.
    const otherUserId = `user_${randomUUID().slice(0, 8)}`;
    const writeDbSeed = store.set(writeDb$);
    await writeDbSeed.insert(orgCustomConnectorSecrets).values({
      connectorId: fixture.connectorId,
      userId: otherUserId,
      orgId: fixture.orgId,
      encryptedValue: "other-user-secret",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.delete({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const writeDb = store.set(writeDb$);
    const survivors = await writeDb
      .select()
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, fixture.connectorId));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.userId).toBe(otherUserId);

    // The fixture tracker only deletes the connector-owned cascade, but the
    // unmanaged extra row also lives on this connector and is cleaned by
    // deleteCustomConnectorOrg$ on afterEach. No explicit cleanup needed.
  });

  it("does not leak across orgs (same userId in two orgs)", async () => {
    const sharedUserId = `user_${randomUUID().slice(0, 8)}`;
    const orgAFixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { userId: sharedUserId, withSecret: true },
        context.signal,
      ),
    );
    const orgBFixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { userId: sharedUserId, withSecret: true },
        context.signal,
      ),
    );

    // Authenticate as sharedUser in orgA. DELETE orgA's connector secret.
    mocks.clerk.session(sharedUserId, orgAFixture.orgId);
    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.delete({
        params: { id: orgAFixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    // orgA secret gone; orgB secret survives.
    const writeDb = store.set(writeDb$);
    const orgARows = await writeDb
      .select()
      .from(orgCustomConnectorSecrets)
      .where(
        eq(orgCustomConnectorSecrets.connectorId, orgAFixture.connectorId),
      );
    expect(orgARows).toHaveLength(0);
    const orgBRows = await writeDb
      .select()
      .from(orgCustomConnectorSecrets)
      .where(
        eq(orgCustomConnectorSecrets.connectorId, orgBFixture.connectorId),
      );
    expect(orgBRows).toHaveLength(1);
  });
});
