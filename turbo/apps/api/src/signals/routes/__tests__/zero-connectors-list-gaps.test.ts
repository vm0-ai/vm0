import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

const trackOrg = createFixtureTracker<string>(async (orgId) => {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
});

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function connectorsClient() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

async function insertRemovedConnectorRow(owner: Actor): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    userId: owner.userId,
    orgId: owner.orgId,
    type: "__removed_connector__",
    authMethod: "oauth",
  });
  await trackOrg(Promise.resolve(owner.orgId));
}

describe("/api/zero/connectors list helper gaps", () => {
  it("skips stored OAuth rows whose type no longer exists in the contract", async () => {
    const owner = actor();
    await insertRemovedConnectorRow(owner);
    mocks.clerk.session(owner.userId, owner.orgId);

    const response = await accept(
      connectorsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      response.body.connectors.find((connector) => {
        return (connector.type as string) === "__removed_connector__";
      }),
    ).toBeUndefined();
  });
});
