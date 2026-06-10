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
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
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

interface StoredSecretSeed {
  readonly name: string;
  readonly encryptedValue: string;
}

interface StoredVariableSeed {
  readonly name: string;
  readonly value: string;
}

interface StoredConnectorSeed {
  readonly owner: Actor;
  readonly type: ConnectorType;
  readonly authMethod: string;
  readonly secrets?: readonly StoredSecretSeed[];
  readonly variables?: readonly StoredVariableSeed[];
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

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
}

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

async function insertStoredConnector(seed: StoredConnectorSeed): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(connectors).values({
    orgId: seed.owner.orgId,
    userId: seed.owner.userId,
    type: seed.type,
    authMethod: seed.authMethod,
  });

  if (seed.secrets !== undefined && seed.secrets.length > 0) {
    await writeDb.insert(secrets).values(
      seed.secrets.map((secret) => {
        return {
          orgId: seed.owner.orgId,
          userId: seed.owner.userId,
          name: secret.name,
          encryptedValue: secret.encryptedValue,
          type: "connector",
        };
      }),
    );
  }

  if (seed.variables !== undefined && seed.variables.length > 0) {
    await writeDb.insert(variables).values(
      seed.variables.map((variable) => {
        return {
          orgId: seed.owner.orgId,
          userId: seed.owner.userId,
          name: variable.name,
          value: variable.value,
          type: "connector",
        };
      }),
    );
  }

  await trackOrg(Promise.resolve(seed.owner.orgId));
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

async function deleteConnector(
  owner: Actor,
  type: ConnectorType,
): Promise<void> {
  mockSession(owner);
  await accept(
    byTypeClient().delete({
      params: { type },
      headers: authHeaders(),
    }),
    [204],
  );
}

async function storedCounts(owner: Actor): Promise<{
  readonly connectors: number;
  readonly secrets: number;
  readonly variables: number;
}> {
  const writeDb = store.set(writeDb$);
  const [connectorRows, secretRows, variableRows] = await Promise.all([
    writeDb
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, owner.orgId),
          eq(connectors.userId, owner.userId),
        ),
      ),
    writeDb
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(eq(secrets.orgId, owner.orgId), eq(secrets.userId, owner.userId)),
      ),
    writeDb
      .select({ id: variables.id })
      .from(variables)
      .where(
        and(
          eq(variables.orgId, owner.orgId),
          eq(variables.userId, owner.userId),
        ),
      ),
  ]);

  return {
    connectors: connectorRows.length,
    secrets: secretRows.length,
    variables: variableRows.length,
  };
}

async function storedConnectorVariables(owner: Actor): Promise<
  readonly {
    readonly name: string;
    readonly value: string;
    readonly type: string;
  }[]
> {
  const writeDb = store.set(writeDb$);
  return await writeDb
    .select({
      name: variables.name,
      value: variables.value,
      type: variables.type,
    })
    .from(variables)
    .where(
      and(
        eq(variables.orgId, owner.orgId),
        eq(variables.userId, owner.userId),
        eq(variables.type, "connector"),
      ),
    )
    .orderBy(variables.name);
}

describe("/api/zero/connectors/:type delete helper gaps", () => {
  it("revokes the configured OAuth token input before deleting local state", async () => {
    const owner = actor();
    await insertStoredConnector({
      owner,
      type: "github",
      authMethod: "oauth",
      secrets: [
        {
          name: "GITHUB_ACCESS_TOKEN",
          encryptedValue: encryptSecretForTests("gh-revoke-input-token"),
        },
      ],
    });
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    let revokeBody = "";
    server.use(
      http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        async ({ request }) => {
          revokeBody = await request.text();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );

    await deleteConnector(owner, "github");

    expect(revokeBody).toBe(
      JSON.stringify({ access_token: "gh-revoke-input-token" }),
    );
    await expect(storedCounts(owner)).resolves.toStrictEqual({
      connectors: 0,
      secrets: 0,
      variables: 0,
    });
  });

  it("keeps local deletion authoritative when remote OAuth token revoke fails", async () => {
    const owner = actor();
    await insertStoredConnector({
      owner,
      type: "github",
      authMethod: "oauth",
      secrets: [
        {
          name: "GITHUB_ACCESS_TOKEN",
          encryptedValue: encryptSecretForTests("gh-access-token"),
        },
      ],
    });
    mockOptionalEnv("GH_OAUTH_CLIENT_ID", "test-client-id");
    mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", "test-client-secret");
    server.use(
      http.delete(
        "https://api.github.com/applications/test-client-id/grant",
        () => {
          return HttpResponse.json(
            { error: "forced revoke failure" },
            { status: 500 },
          );
        },
      ),
    );

    await deleteConnector(owner, "github");

    await expect(storedCounts(owner)).resolves.toStrictEqual({
      connectors: 0,
      secrets: 0,
      variables: 0,
    });
  });

  it("deletes stored OAuth connector secrets for connectors without token revoke", async () => {
    const owner = actor();
    await insertStoredConnector({
      owner,
      type: "slock",
      authMethod: "oauth",
      secrets: [
        {
          name: "SLOCK_ACCESS_TOKEN",
          encryptedValue: "encrypted_slock_access_token",
        },
        {
          name: "SLOCK_REFRESH_TOKEN",
          encryptedValue: "encrypted_slock_refresh_token",
        },
        {
          name: "SLOCK_SERVER_ID",
          encryptedValue: "encrypted_slock_server_id",
        },
      ],
    });

    await deleteConnector(owner, "slock");

    await expect(storedCounts(owner)).resolves.toStrictEqual({
      connectors: 0,
      secrets: 0,
      variables: 0,
    });
  });

  it("removes hidden connector-owned variables without deleting other connector variable rows", async () => {
    const owner = actor();
    await connectManualGrant({
      owner,
      type: "atlassian",
      values: {
        ATLASSIAN_TOKEN: "atlassian-token",
        ATLASSIAN_EMAIL: "test@example.com",
        ATLASSIAN_DOMAIN: "example",
      },
    });
    await connectManualGrant({
      owner,
      type: "gitlab",
      values: {
        GITLAB_TOKEN: "glpat-test",
        GITLAB_HOST: "gitlab.example.com",
      },
    });

    await deleteConnector(owner, "atlassian");

    await expect(storedConnectorVariables(owner)).resolves.toStrictEqual([
      {
        name: "GITLAB_HOST",
        value: "gitlab.example.com",
        type: "connector",
      },
    ]);

    await deleteConnector(owner, "gitlab");

    await expect(storedCounts(owner)).resolves.toStrictEqual({
      connectors: 0,
      secrets: 0,
      variables: 0,
    });
  });
});
