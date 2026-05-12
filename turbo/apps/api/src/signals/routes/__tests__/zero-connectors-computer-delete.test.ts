import { randomUUID } from "node:crypto";

import { zeroComputerConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { server } from "../../../mocks/server";
import { encryptSecretValue } from "../../services/crypto.utils";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

interface NgrokDeleteCalls {
  readonly deleteCredential: string[];
  readonly deleteEndpoint: string[];
  readonly deleteReservedDomain: string[];
  readonly deleteBotUser: string[];
}

const COMPUTER_SECRET_NAMES = [
  "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
  "COMPUTER_CONNECTOR_DOMAIN_ID",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const;

function setupNgrokDeleteMocks(): NgrokDeleteCalls {
  const calls: NgrokDeleteCalls = {
    deleteCredential: [],
    deleteEndpoint: [],
    deleteReservedDomain: [],
    deleteBotUser: [],
  };

  server.use(
    http.delete("https://api.ngrok.com/credentials/:id", ({ params }) => {
      calls.deleteCredential.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("https://api.ngrok.com/endpoints/:id", ({ params }) => {
      calls.deleteEndpoint.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("https://api.ngrok.com/reserved_domains/:id", ({ params }) => {
      calls.deleteReservedDomain.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("https://api.ngrok.com/bot_users/:id", ({ params }) => {
      calls.deleteBotUser.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return calls;
}

async function cleanupOrgData(fixture: OrgMembershipFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

function seedFixture(): Promise<OrgMembershipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  return store.set(seedOrgMembership$, { orgId, userId }, context.signal);
}

async function seedComputerConnector(
  fixture: OrgMembershipFixture,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    type: "computer",
    authMethod: "api",
    externalId: "bot_test_connector_123",
    externalUsername: "cr_test_connector_456",
    externalEmail: "ep_test_connector_789",
  });
  await writeDb.insert(secrets).values([
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
      encryptedValue: encryptSecretValue("bridge-token"),
      type: "connector",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "COMPUTER_CONNECTOR_DOMAIN_ID",
      encryptedValue: encryptSecretValue("rd_test_connector_abc"),
      type: "connector",
    },
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "COMPUTER_CONNECTOR_DOMAIN",
      encryptedValue: encryptSecretValue("computer.example.com"),
      type: "connector",
    },
  ]);
}

async function remainingComputerConnectorCount(
  fixture: OrgMembershipFixture,
): Promise<number> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
        eq(connectors.type, "computer"),
      ),
    );
  return rows.length;
}

async function remainingComputerSecretNames(
  fixture: OrgMembershipFixture,
): Promise<string[]> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ name: secrets.name })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, fixture.orgId),
        eq(secrets.userId, fixture.userId),
        eq(secrets.type, "connector"),
      ),
    );
  return rows
    .map((row) => {
      return row.name;
    })
    .filter((name) => {
      return COMPUTER_SECRET_NAMES.some((secretName) => {
        return secretName === name;
      });
    });
}

describe("DELETE /api/zero/connectors/computer", () => {
  const track = createFixtureTracker<OrgMembershipFixture>(cleanupOrgData);

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(client.delete({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when no computer connector is configured", async () => {
    const fixture = await track(seedFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer connector not found", code: "NOT_FOUND" },
    });
  });

  it("deletes the computer connector and ngrok resources", async () => {
    const fixture = await track(seedFixture());
    await seedComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokDeleteMocks();

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [204],
    );

    expect(response.body).toBeUndefined();
    expect(ngrokCalls.deleteCredential).toStrictEqual([
      "cr_test_connector_456",
    ]);
    expect(ngrokCalls.deleteEndpoint).toStrictEqual(["ep_test_connector_789"]);
    expect(ngrokCalls.deleteReservedDomain).toStrictEqual([
      "rd_test_connector_abc",
    ]);
    expect(ngrokCalls.deleteBotUser).toStrictEqual(["bot_test_connector_123"]);
    await expect(remainingComputerConnectorCount(fixture)).resolves.toBe(0);
    await expect(remainingComputerSecretNames(fixture)).resolves.toStrictEqual(
      [],
    );
  });

  it("deletes local computer connector state when ngrok is not configured", async () => {
    const fixture = await track(seedFixture());
    await seedComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", undefined);

    const client = setupApp({ context })(zeroComputerConnectorContract);
    const response = await accept(
      client.delete({ headers: { authorization: "Bearer clerk-session" } }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(remainingComputerConnectorCount(fixture)).resolves.toBe(0);
    await expect(remainingComputerSecretNames(fixture)).resolves.toStrictEqual(
      [],
    );
  });
});
