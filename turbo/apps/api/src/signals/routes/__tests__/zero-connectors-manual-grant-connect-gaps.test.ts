import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

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

interface ConnectorSecretSeed {
  readonly name: string;
  readonly encryptedValue: string;
}

interface ConnectorVariableSeed {
  readonly name: string;
  readonly value: string;
}

interface StoredConnectorState {
  readonly owner: Actor;
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly tokenExpiresAt?: Date;
  readonly needsReconnect?: boolean;
  readonly secrets?: readonly ConnectorSecretSeed[];
  readonly variables?: readonly ConnectorVariableSeed[];
}

const trackOrg = createFixtureTracker<string>(async (orgId) => {
  const writeDb = store.set(writeDb$);
  await writeDb.delete(connectors).where(eq(connectors.orgId, orgId));
  await writeDb.delete(secrets).where(eq(secrets.orgId, orgId));
  await writeDb.delete(variables).where(eq(variables.orgId, orgId));
});

function actor(): Actor {
  return {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

async function insertStoredConnectorState(
  state: StoredConnectorState,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: state.owner.orgId,
    userId: state.owner.userId,
    type: state.type,
    authMethod: state.authMethod,
    tokenExpiresAt: state.tokenExpiresAt,
    needsReconnect: state.needsReconnect ?? false,
  });

  if (state.secrets !== undefined && state.secrets.length > 0) {
    await writeDb.insert(secrets).values(
      state.secrets.map((secret) => {
        return {
          orgId: state.owner.orgId,
          userId: state.owner.userId,
          name: secret.name,
          encryptedValue: secret.encryptedValue,
          type: "connector",
        };
      }),
    );
  }

  if (state.variables !== undefined && state.variables.length > 0) {
    await writeDb.insert(variables).values(
      state.variables.map((variable) => {
        return {
          orgId: state.owner.orgId,
          userId: state.owner.userId,
          name: variable.name,
          value: variable.value,
          type: "connector",
        };
      }),
    );
  }

  await trackOrg(Promise.resolve(state.owner.orgId));
}

async function connectManualGrant(args: {
  readonly owner: Actor;
  readonly type: ConnectorType;
  readonly values: Record<string, string>;
}): Promise<void> {
  mockSession(args.owner);
  await accept(
    manualGrantClient().connect({
      params: { type: args.type },
      body: {
        authMethod: "api-token",
        values: args.values,
      },
      headers: authHeaders(),
    }),
    [200],
  );
  await trackOrg(Promise.resolve(args.owner.orgId));
}

async function storedSecretNames(owner: Actor): Promise<readonly string[]> {
  const writeDb = store.set(writeDb$);
  const rows = await writeDb
    .select({ name: secrets.name })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, owner.orgId),
        eq(secrets.userId, owner.userId),
        eq(secrets.type, "connector"),
      ),
    );

  return rows.map((row) => {
    return row.name;
  });
}

async function storedConnectorRows(
  owner: Actor,
  type: ConnectorType,
): Promise<
  readonly {
    readonly authMethod: string;
    readonly tokenExpiresAt: Date | null;
    readonly needsReconnect: boolean;
  }[]
> {
  const writeDb = store.set(writeDb$);
  return await writeDb
    .select({
      authMethod: connectors.authMethod,
      tokenExpiresAt: connectors.tokenExpiresAt,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, owner.orgId),
        eq(connectors.userId, owner.userId),
        eq(connectors.type, type),
      ),
    );
}

async function storedVariableRows(
  owner: Actor,
  name: string,
): Promise<readonly { readonly value: string }[]> {
  const writeDb = store.set(writeDb$);
  return await writeDb
    .select({ value: variables.value })
    .from(variables)
    .where(
      and(
        eq(variables.orgId, owner.orgId),
        eq(variables.userId, owner.userId),
        eq(variables.name, name),
        eq(variables.type, "connector"),
      ),
    );
}

describe("/api/zero/connectors/:type/manual-grant helper gaps", () => {
  it("clears stale Lark access-token storage on manual grant reconnect", async () => {
    const owner = actor();
    await insertStoredConnectorState({
      owner,
      type: "lark",
      authMethod: "api-token",
      tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      needsReconnect: true,
      secrets: [
        {
          name: "LARK_TOKEN",
          encryptedValue: "encrypted_legacy_lark_token",
        },
        {
          name: "LARK_ACCESS_TOKEN",
          encryptedValue: "encrypted_stale_lark_access_token",
        },
      ],
    });

    await connectManualGrant({
      owner,
      type: "lark",
      values: {
        LARK_APP_ID: "cli_new",
        LARK_APP_SECRET: "new-lark-app-secret",
      },
    });

    mockSession(owner);
    const read = await accept(
      byTypeClient().get({
        params: { type: "lark" },
        headers: authHeaders(),
      }),
      [200],
    );
    const secretNames = await storedSecretNames(owner);

    expect(read.body).toMatchObject({
      type: "lark",
      authMethod: "api-token",
      connectionStatus: "connected",
      tokenExpiresAt: null,
    });
    await expect(storedConnectorRows(owner, "lark")).resolves.toStrictEqual([
      {
        authMethod: "api-token",
        tokenExpiresAt: null,
        needsReconnect: false,
      },
    ]);
    expect(secretNames).toStrictEqual(
      expect.arrayContaining(["LARK_APP_SECRET", "LARK_TOKEN"]),
    );
    expect(secretNames).not.toContain("LARK_ACCESS_TOKEN");
  });

  it("replaces stored OAuth secrets with manual grant storage", async () => {
    const owner = actor();
    await insertStoredConnectorState({
      owner,
      type: "stripe",
      authMethod: "oauth",
      secrets: [
        {
          name: "STRIPE_ACCESS_TOKEN",
          encryptedValue: "encrypted_stripe_access_token",
        },
        {
          name: "STRIPE_REFRESH_TOKEN",
          encryptedValue: "encrypted_stripe_refresh_token",
        },
      ],
    });

    await connectManualGrant({
      owner,
      type: "stripe",
      values: { STRIPE_TOKEN: "sk_test_key" },
    });

    mockSession(owner);
    const read = await accept(
      byTypeClient().get({
        params: { type: "stripe" },
        headers: authHeaders(),
      }),
      [200],
    );
    const secretNames = await storedSecretNames(owner);

    expect(read.body).toMatchObject({
      type: "stripe",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    expect(secretNames).toContain("STRIPE_TOKEN");
    expect(secretNames).not.toContain("STRIPE_ACCESS_TOKEN");
    expect(secretNames).not.toContain("STRIPE_REFRESH_TOKEN");
  });

  it("removes omitted optional manual-grant variables on replacement", async () => {
    const owner = actor();
    await connectManualGrant({
      owner,
      type: "gitlab",
      values: {
        GITLAB_TOKEN: "glpat-first",
        GITLAB_HOST: "gitlab.example.com",
      },
    });

    await connectManualGrant({
      owner,
      type: "gitlab",
      values: { GITLAB_TOKEN: "glpat-second" },
    });

    await expect(
      storedVariableRows(owner, "GITLAB_HOST"),
    ).resolves.toHaveLength(0);
  });
});
