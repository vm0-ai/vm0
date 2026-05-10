import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { zeroCustomConnectorByIdContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function uniqueOrg(prefix: string) {
  const userId = `user_${prefix}_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${prefix}_${randomUUID().slice(0, 8)}`;
  return { userId, orgId };
}

async function seedCustomConnector(orgId: string, userId: string) {
  const id = randomUUID();
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgCustomConnectors).values({
    id,
    orgId,
    slug: `seed-${randomUUID().slice(0, 8)}`,
    displayName: "Seeded",
    prefixes: ["https://api.example.org/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    createdBy: userId,
  });
  return id;
}

async function seedConnectorSecret(
  orgId: string,
  userId: string,
  connectorId: string,
) {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(orgCustomConnectorSecrets).values({
    connectorId,
    userId,
    orgId,
    encryptedValue: "fake-encrypted-blob",
  });
}

describe("DELETE /api/zero/custom-connectors/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin members and leaves the row in place", async () => {
    const { userId, orgId } = uniqueOrg("zcc-del-member");
    const id = await seedCustomConnector(orgId, userId);
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can delete custom connectors",
        code: "FORBIDDEN",
      },
    });

    // Sanity: the row is still there (delete was rejected, not silently performed).
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, id));
    expect(row?.id).toBe(id);
  });

  it("returns 404 for an unknown id", async () => {
    const { userId, orgId } = uniqueOrg("zcc-del-404");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("deletes connector as admin and cascades secrets", async () => {
    const { userId, orgId } = uniqueOrg("zcc-del-cascade");
    const id = await seedCustomConnector(orgId, userId);
    await seedConnectorSecret(orgId, userId, id);
    mocks.clerk.session(userId, orgId, "org:admin");

    // Pre-condition: secret row exists.
    const writeDb = store.set(writeDb$);
    const [secretBefore] = await writeDb
      .select({ connectorId: orgCustomConnectorSecrets.connectorId })
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, id));
    expect(secretBefore?.connectorId).toBe(id);

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await client.delete({
      params: { id },
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(response.status).toBe(204);

    // Connector row removed
    const [connectorRow] = await writeDb
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, id));
    expect(connectorRow).toBeUndefined();

    // Secret row also removed (cascade)
    const [secretRow] = await writeDb
      .select({ connectorId: orgCustomConnectorSecrets.connectorId })
      .from(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, id));
    expect(secretRow).toBeUndefined();
  });

  it("returns 404 for a connector in another org and leaves the row in place", async () => {
    const orgA = uniqueOrg("zcc-del-orgA");
    const id = await seedCustomConnector(orgA.orgId, orgA.userId);

    const orgB = uniqueOrg("zcc-del-orgB");
    mocks.clerk.session(orgB.userId, orgB.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.delete({
        params: { id },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND" },
    });

    // Sanity: the connector is still there in org A.
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({ id: orgCustomConnectors.id, orgId: orgCustomConnectors.orgId })
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, id));
    expect(row?.orgId).toBe(orgA.orgId);
  });
});
