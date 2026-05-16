import { randomUUID } from "node:crypto";

import {
  zeroConnectorApiTokenContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { connectorCliAuthSessions } from "@vm0/db/schema/connector-cli-auth-session";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
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

async function cleanupOrgData(fixture: OrgMembershipFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(connectorCliAuthSessions)
    .where(eq(connectorCliAuthSessions.orgId, fixture.orgId));
  await writeDb.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await writeDb.delete(variables).where(eq(variables.orgId, fixture.orgId));
  await writeDb
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

function seedFixture(): Promise<OrgMembershipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  return store.set(seedOrgMembership$, { orgId, userId }, context.signal);
}

function client() {
  return setupApp({ context })(zeroConnectorApiTokenContract);
}

function listClient() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

async function userSecretValue(
  fixture: OrgMembershipFixture,
  name: string,
): Promise<string | null> {
  const [row] = await store
    .set(writeDb$)
    .select({ encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, fixture.orgId),
        eq(secrets.userId, fixture.userId),
        eq(secrets.name, name),
        eq(secrets.type, "user"),
      ),
    )
    .limit(1);
  return row ? decryptSecretValue(row.encryptedValue) : null;
}

async function variableValue(
  fixture: OrgMembershipFixture,
  name: string,
): Promise<string | null> {
  const [row] = await store
    .set(writeDb$)
    .select({ value: variables.value })
    .from(variables)
    .where(
      and(
        eq(variables.orgId, fixture.orgId),
        eq(variables.userId, fixture.userId),
        eq(variables.name, name),
      ),
    )
    .limit(1);
  return row?.value ?? null;
}

describe("POST /api/zero/connectors/:type/api-token", () => {
  const track = createFixtureTracker<OrgMembershipFixture>(cleanupOrgData);

  it("connects a first-time API-token connector and splits secrets from variables", async () => {
    const fixture = await track(seedFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      client().connect({
        params: { type: "strapi" },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          values: {
            STRAPI_TOKEN: " strapi\n token ",
            STRAPI_BASE_URL: " https://strapi.example.com\n",
          },
        },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: null,
      type: "strapi",
      authMethod: "api-token",
    });
    await expect(userSecretValue(fixture, "STRAPI_TOKEN")).resolves.toBe(
      "strapitoken",
    );
    await expect(variableValue(fixture, "STRAPI_BASE_URL")).resolves.toBe(
      "https://strapi.example.com",
    );
  });

  it("replaces an existing OAuth connector row and connector-scoped secrets", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await writeDb.insert(connectors).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "stripe",
      authMethod: "oauth",
      externalId: "acct_existing",
      oauthScopes: JSON.stringify(["read_write"]),
    });
    await writeDb.insert(secrets).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "STRIPE_ACCESS_TOKEN",
        encryptedValue: "encrypted-access",
        type: "connector",
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "STRIPE_REFRESH_TOKEN",
        encryptedValue: "encrypted-refresh",
        type: "connector",
      },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().connect({
        params: { type: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
        body: { values: { STRIPE_TOKEN: "sk_test_replacement" } },
      }),
      [200],
    );

    const [connectorRows, connectorSecretRows, listResponse] =
      await Promise.all([
        writeDb
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              eq(connectors.orgId, fixture.orgId),
              eq(connectors.userId, fixture.userId),
              eq(connectors.type, "stripe"),
            ),
          ),
        writeDb
          .select({ id: secrets.id })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, fixture.orgId),
              eq(secrets.userId, fixture.userId),
              eq(secrets.type, "connector"),
              inArray(secrets.name, [
                "STRIPE_ACCESS_TOKEN",
                "STRIPE_REFRESH_TOKEN",
              ]),
            ),
          ),
        accept(
          listClient().list({
            headers: { authorization: "Bearer clerk-session" },
          }),
          [200],
        ),
      ]);

    expect(connectorRows).toStrictEqual([]);
    expect(connectorSecretRows).toStrictEqual([]);
    await expect(userSecretValue(fixture, "STRIPE_TOKEN")).resolves.toBe(
      "sk_test_replacement",
    );
    expect(
      listResponse.body.connectors.find((connector) => {
        return connector.type === "stripe";
      }),
    ).toMatchObject({ type: "stripe", authMethod: "api-token" });
  });

  it("deletes omitted optional API-token fields during replacement", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await writeDb.insert(secrets).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "AGORA_APP_CERTIFICATE",
      encryptedValue: "encrypted-optional",
      type: "user",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().connect({
        params: { type: "agora" },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          values: {
            AGORA_CUSTOMER_ID: "customer",
            AGORA_CUSTOMER_SECRET: "secret",
            AGORA_APP_ID: "app",
          },
        },
      }),
      [200],
    );

    await expect(
      userSecretValue(fixture, "AGORA_APP_CERTIFICATE"),
    ).resolves.toBeNull();
    await expect(userSecretValue(fixture, "AGORA_CUSTOMER_ID")).resolves.toBe(
      "customer",
    );
    await expect(variableValue(fixture, "AGORA_APP_ID")).resolves.toBe("app");

    const connector = await accept(
      byTypeClient().get({
        params: { type: "agora" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connector.body).toMatchObject({
      type: "agora",
      authMethod: "api-token",
    });
  });

  it("invalidates active Stripe CLI auth sessions", async () => {
    const fixture = await track(seedFixture());
    const writeDb = store.set(writeDb$);
    await writeDb.insert(connectorCliAuthSessions).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "stripe",
      source: "stripe-cli",
      status: "awaiting_user_approval",
      approvalUrl: "https://dashboard.stripe.com/confirm",
      verificationCode: "code",
      expiresAt: new Date(nowDate().getTime() + 60_000),
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      client().connect({
        params: { type: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
        body: { values: { STRIPE_TOKEN: "sk_test_replacement" } },
      }),
      [200],
    );

    const [session] = await writeDb
      .select({
        status: connectorCliAuthSessions.status,
        errorMessage: connectorCliAuthSessions.errorMessage,
        approvalUrl: connectorCliAuthSessions.approvalUrl,
        verificationCode: connectorCliAuthSessions.verificationCode,
      })
      .from(connectorCliAuthSessions)
      .where(
        and(
          eq(connectorCliAuthSessions.orgId, fixture.orgId),
          eq(connectorCliAuthSessions.userId, fixture.userId),
        ),
      );

    expect(session).toMatchObject({
      status: "cancelled",
      errorMessage:
        "CLI auth for Stripe session was cancelled because Stripe credentials changed",
      approvalUrl: null,
      verificationCode: null,
    });
  });

  it("rejects invalid API-token submissions without echoing values", async () => {
    const fixture = await track(seedFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const missingRequired = await accept(
      client().connect({
        params: { type: "strapi" },
        headers: { authorization: "Bearer clerk-session" },
        body: { values: { STRAPI_BASE_URL: "https://strapi.example.com" } },
      }),
      [400],
    );
    const unknown = await accept(
      client().connect({
        params: { type: "strapi" },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          values: {
            STRAPI_TOKEN: "secret-token-value",
            STRAPI_BASE_URL: "https://strapi.example.com",
            EXTRA_TOKEN: "secret-extra-value",
          },
        },
      }),
      [400],
    );
    const unsupported = await accept(
      client().connect({
        params: { type: "github" },
        headers: { authorization: "Bearer clerk-session" },
        body: { values: { GITHUB_ACCESS_TOKEN: "ghp_secret" } },
      }),
      [400],
    );
    const disabled = await accept(
      client().connect({
        params: { type: "bentoml" },
        headers: { authorization: "Bearer clerk-session" },
        body: {
          values: {
            BENTO_CLOUD_API_KEY: "secret-bento",
            BENTO_CLOUD_API_ENDPOINT: "https://example.bentoml.cloud",
          },
        },
      }),
      [403],
    );

    expect(missingRequired.body.error.message).toContain("STRAPI_TOKEN");
    expect(unknown.body.error.message).toContain("EXTRA_TOKEN");
    expect(unknown.body.error.message).not.toContain("secret-extra-value");
    expect(unsupported.body.error.message).toContain(
      "does not support API-token auth",
    );
    expect(disabled.body.error.code).toBe("FORBIDDEN");
  });
});
