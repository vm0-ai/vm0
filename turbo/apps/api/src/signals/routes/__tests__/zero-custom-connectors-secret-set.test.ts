import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import {
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
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

describe("PUT /api/zero/custom-connectors/:id/secret", () => {
  const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
    return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
  });

  it("returns 401 when the user has no active organization", async () => {
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("stores per-user secret and round-trips through decryptSecretValue", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.set({
        params: { id: fixture.connectorId },
        body: { value: "sk_live_xyz" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        encryptedValue: orgCustomConnectorSecrets.encryptedValue,
        userId: orgCustomConnectorSecrets.userId,
        orgId: orgCustomConnectorSecrets.orgId,
      })
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, fixture.connectorId));
    expect(row).toBeDefined();
    expect(row!.userId).toBe(fixture.userId);
    expect(row!.orgId).toBe(fixture.orgId);
    expect(decryptSecretValue(row!.encryptedValue)).toBe("sk_live_xyz");

    const listClient = setupApp({ context })(zeroCustomConnectorsContract);
    const listResponse = await accept(
      listClient.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(listResponse.body.connectors[0]?.hasSecret).toBeTruthy();
  });

  it("returns 404 for an unknown connector id", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    const response = await accept(
      client.set({
        params: { id: randomUUID() },
        body: { value: "x" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("allows an org member (non-admin) to set their own secret", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    // The connector creator was fixture.userId (the seeding admin). A different
    // user in the same org should be able to set their own secret.
    const memberUserId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorSecretContract);
    await accept(
      client.set({
        params: { id: fixture.connectorId },
        body: { value: "member-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ encryptedValue: orgCustomConnectorSecrets.encryptedValue })
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.userId, memberUserId));
    expect(row).toBeDefined();
    expect(decryptSecretValue(row!.encryptedValue)).toBe("member-token");
  });
});
