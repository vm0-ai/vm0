import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

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

describe("PATCH /api/zero/custom-connectors/:id", () => {
  const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
    return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
  });

  async function getDisplayName(
    connectorId: string,
  ): Promise<string | undefined> {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ displayName: orgCustomConnectors.displayName })
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, connectorId));
    return row?.displayName;
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: randomUUID() },
        headers: {},
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin members", async () => {
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "Hacked" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can rename custom connectors",
        code: "FORBIDDEN",
      },
    });

    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Original");
  });

  it("renames a connector as admin and persists it (read-after-write)", async () => {
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original", slug: "patch-happy" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "Renamed" },
      }),
      [200],
    );

    expect(response.body.id).toBe(fixture.connectorId);
    expect(response.body.displayName).toBe("Renamed");
    expect(response.body.slug).toBe("patch-happy");
    expect(response.body.hasSecret).toBeFalsy();

    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Renamed");
  });

  it("returns 404 for an unknown connector id", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: unknownId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "Renamed" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });
  });

  it("returns 404 when the connector belongs to another org (no existence leak)", async () => {
    const otherFixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "OtherOrg" },
        context.signal,
      ),
    );

    const myFixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: otherFixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "Hijacked" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });

    await expect(getDisplayName(otherFixture.connectorId)).resolves.toBe(
      "OtherOrg",
    );
  });

  it("rejects empty displayName with 400", async () => {
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        { displayName: "Original" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connectorId },
        headers: { authorization: "Bearer clerk-session" },
        body: { displayName: "" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    await expect(getDisplayName(fixture.connectorId)).resolves.toBe("Original");
  });
});
