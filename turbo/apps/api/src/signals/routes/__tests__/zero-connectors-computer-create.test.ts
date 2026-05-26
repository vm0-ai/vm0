import { randomUUID } from "node:crypto";

import { zeroComputerConnectorContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const COMPUTER_SECRET_NAMES = Object.freeze([
  "COMPUTER_CONNECTOR_BRIDGE_TOKEN",
  "COMPUTER_CONNECTOR_DOMAIN_ID",
  "COMPUTER_CONNECTOR_DOMAIN",
] as const);

interface OrgUserFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface NgrokCalls {
  readonly createBotUser: string[];
  readonly listBotUsers: string[];
  readonly filterEndpoints: string[];
  readonly patchEndpoint: string[];
  readonly filterReservedDomains: string[];
  readonly createCredential: string[];
  readonly deleteCredential: string[];
  readonly createEndpoint: string[];
  readonly deleteEndpoint: string[];
  readonly createReservedDomain: string[];
  readonly deleteReservedDomain: string[];
  readonly deleteBotUser: string[];
}

function uniqueOrgUser(prefix: string): OrgUserFixture {
  return {
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

async function deleteFixture(fixture: OrgUserFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await db
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, fixture.orgId));
}

async function enableComputerConnector(fixture: OrgUserFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.ComputerConnector]: true },
  });
}

function setupNgrokMocks(): NgrokCalls {
  const calls: NgrokCalls = {
    createBotUser: [],
    listBotUsers: [],
    filterEndpoints: [],
    patchEndpoint: [],
    filterReservedDomains: [],
    createCredential: [],
    deleteCredential: [],
    createEndpoint: [],
    deleteEndpoint: [],
    createReservedDomain: [],
    deleteReservedDomain: [],
    deleteBotUser: [],
  };

  server.use(
    http.post("https://api.ngrok.com/bot_users", async ({ request }) => {
      const body = (await request.json()) as { name: string };
      calls.createBotUser.push(body.name);
      return HttpResponse.json({ id: "bot_test_123", name: body.name });
    }),
    http.get("https://api.ngrok.com/bot_users", ({ request }) => {
      calls.listBotUsers.push(new URL(request.url).search);
      return HttpResponse.json({ bot_users: [], next_page_uri: null });
    }),
    http.post("https://api.ngrok.com/credentials", async ({ request }) => {
      const body = (await request.json()) as {
        owner_id: string;
        acl: string[];
      };
      calls.createCredential.push(body.owner_id);
      return HttpResponse.json({
        id: "cr_test_456",
        token: "2abc_test_ngrok_authtoken",
      });
    }),
    http.delete("https://api.ngrok.com/credentials/:id", ({ params }) => {
      calls.deleteCredential.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("https://api.ngrok.com/reserved_domains", ({ request }) => {
      const url = new URL(request.url);
      calls.filterReservedDomains.push(url.searchParams.get("filter") ?? "");
      return HttpResponse.json({
        reserved_domains: [],
        next_page_uri: null,
      });
    }),
    http.post("https://api.ngrok.com/reserved_domains", async ({ request }) => {
      const body = (await request.json()) as { name: string; region: string };
      calls.createReservedDomain.push(body.name);
      return HttpResponse.json({
        id: "rd_test_abc",
        domain: `${body.name}.ngrok-free.app`,
        region: body.region,
        cname_target: null,
      });
    }),
    http.delete("https://api.ngrok.com/reserved_domains/:id", ({ params }) => {
      calls.deleteReservedDomain.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("https://api.ngrok.com/endpoints", ({ request }) => {
      const url = new URL(request.url);
      calls.filterEndpoints.push(url.searchParams.get("filter") ?? "");
      return HttpResponse.json({ endpoints: [], next_page_uri: null });
    }),
    http.patch("https://api.ngrok.com/endpoints/:id", ({ params }) => {
      calls.patchEndpoint.push(params.id as string);
      return HttpResponse.json({
        id: params.id as string,
        url: "https://*.patched.ngrok-free.app",
      });
    }),
    http.post("https://api.ngrok.com/endpoints", async ({ request }) => {
      const body = (await request.json()) as { url: string };
      calls.createEndpoint.push(body.url);
      return HttpResponse.json({ id: "ep_test_789", url: body.url });
    }),
    http.delete("https://api.ngrok.com/endpoints/:id", ({ params }) => {
      calls.deleteEndpoint.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("https://api.ngrok.com/bot_users/:id", ({ params }) => {
      calls.deleteBotUser.push(params.id as string);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  return calls;
}

async function readConnectorSecrets(
  fixture: OrgUserFixture,
): Promise<Map<string, string>> {
  const db = store.set(writeDb$);
  const rows = await db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, fixture.orgId),
        eq(secrets.userId, fixture.userId),
        eq(secrets.type, "connector"),
      ),
    );
  const values = new Map<string, string>();
  for (const row of rows) {
    values.set(row.name, decryptSecretValue(row.encryptedValue));
  }
  return values;
}

describe("POST /api/zero/connectors/computer", () => {
  const fixtures: OrgUserFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteFixture(fixture);
      }
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroComputerConnectorContract);

    const response = await accept(
      client.create({ body: {}, headers: {} }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const client = setupApp({ context })(zeroComputerConnectorContract);

    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 when the computer connector feature is disabled", async () => {
    const fixture = uniqueOrgUser("zcomp-disabled");
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroComputerConnectorContract);

    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "computer connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("returns 400 when ngrok is not configured", async () => {
    const fixture = uniqueOrgUser("zcomp-no-ngrok");
    fixtures.push(fixture);
    await enableComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroComputerConnectorContract);

    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: "Invalid request",
      code: "BAD_REQUEST",
    });
  });

  it("creates a computer connector", async () => {
    const fixture = uniqueOrgUser("zcomp-create");
    fixtures.push(fixture);
    await enableComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();
    const client = setupApp({ context })(zeroComputerConnectorContract);

    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.id).toBeDefined();
    expect(response.body.ngrokToken).toBe("2abc_test_ngrok_authtoken");
    expect(response.body.bridgeToken).toBeDefined();
    expect(response.body.endpointPrefix).toContain("vm0-user-");
    expect(response.body.domain).toContain(".ngrok-free.app");

    expect(ngrokCalls.createBotUser).toHaveLength(1);
    expect(ngrokCalls.createCredential).toStrictEqual(["bot_test_123"]);
    expect(ngrokCalls.createReservedDomain).toHaveLength(1);
    expect(ngrokCalls.createEndpoint).toStrictEqual([
      `https://*.${response.body.domain}`,
    ]);

    const storedSecrets = await readConnectorSecrets(fixture);
    for (const name of COMPUTER_SECRET_NAMES) {
      expect(storedSecrets.has(name)).toBeTruthy();
    }
    expect(storedSecrets.get("COMPUTER_CONNECTOR_BRIDGE_TOKEN")).toBe(
      response.body.bridgeToken,
    );
    expect(storedSecrets.get("COMPUTER_CONNECTOR_DOMAIN_ID")).toBe(
      "rd_test_abc",
    );
    expect(storedSecrets.get("COMPUTER_CONNECTOR_DOMAIN")).toBe(
      response.body.domain,
    );
  });

  it("returns 409 when the computer connector already exists", async () => {
    const fixture = uniqueOrgUser("zcomp-duplicate");
    fixtures.push(fixture);
    await enableComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    setupNgrokMocks();
    const client = setupApp({ context })(zeroComputerConnectorContract);

    await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const response = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body.error).toStrictEqual({
      message: "Resource conflict",
      code: "CONFLICT",
    });
  });

  it("cleans up resources when endpoint creation fails", async () => {
    const fixture = uniqueOrgUser("zcomp-endpoint-fail");
    fixtures.push(fixture);
    await enableComputerConnector(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockOptionalEnv("NGROK_API_KEY", "test-ngrok-key");
    const ngrokCalls = setupNgrokMocks();
    server.use(
      http.post("https://api.ngrok.com/endpoints", () => {
        return HttpResponse.json({ error: "internal error" }, { status: 500 });
      }),
    );
    const client = setupApp({ context })(zeroComputerConnectorContract);

    await expect(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
    ).rejects.toThrow();

    expect(ngrokCalls.deleteCredential).toStrictEqual(["cr_test_456"]);
    expect(ngrokCalls.deleteReservedDomain).toStrictEqual(["rd_test_abc"]);
    expect(ngrokCalls.deleteBotUser).toStrictEqual(["bot_test_123"]);

    const db = store.set(writeDb$);
    const connectorRows = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(eq(connectors.orgId, fixture.orgId));
    expect(connectorRows).toStrictEqual([]);
  });
});
