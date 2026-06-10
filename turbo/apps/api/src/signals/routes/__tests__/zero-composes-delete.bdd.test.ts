import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
} from "@vm0/api-contracts/contracts/zero-composes";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

interface ComposeFixture extends Actor {
  readonly composeId: string;
  readonly name: string;
}

interface TestComposeContent {
  readonly version: string;
  readonly agents: Record<string, { readonly framework: "claude-code" }>;
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `org_${prefix}_${suffix}`,
    userId: `user_${prefix}_${suffix}`,
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function composeName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function composeContent(name: string): TestComposeContent {
  return {
    version: "1.0",
    agents: {
      [name]: { framework: "claude-code" },
    },
  };
}

function createClient() {
  return setupApp({ context })(composesMainContract);
}

function byIdClient() {
  return setupApp({ context })(zeroComposesByIdContract);
}

function listClient() {
  return setupApp({ context })(zeroComposesListContract);
}

function mockSession(actor: Actor): void {
  mocks.clerk.session(actor.userId, actor.orgId);
}

const trackCompose = createFixtureTracker<ComposeFixture>(async (compose) => {
  mockSession(compose);
  mocks.s3.listObjects([]);
  await accept(
    byIdClient().delete({
      params: { id: compose.composeId },
      headers: authHeaders(),
    }),
    [204, 404],
  );
});

async function createCompose(
  owner: Actor,
  prefix: string,
): Promise<ComposeFixture> {
  const name = composeName(prefix);
  mockSession(owner);
  const response = await accept(
    createClient().create({
      body: { content: composeContent(name) },
      headers: authHeaders(),
    }),
    [201],
  );

  return await trackCompose(
    Promise.resolve({
      ...owner,
      composeId: response.body.composeId,
      name: response.body.name,
    }),
  );
}

async function listedComposeIds(actor: Actor): Promise<readonly string[]> {
  mockSession(actor);
  const response = await accept(
    listClient().list({ query: {}, headers: authHeaders() }),
    [200],
  );
  return response.body.composes.map((compose) => {
    return compose.id;
  });
}

describe("/api/zero/composes/:id delete BDD", () => {
  it("requires authentication and existing compose state", async () => {
    const client = byIdClient();

    const unauthenticated = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const owner = actor("compose_delete_missing");
    mockSession(owner);
    const missing = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missing.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("deletes the caller's compose and removes route-visible state", async () => {
    const owner = actor("compose_delete_owner");
    const compose = await createCompose(owner, "delete-owned-compose");

    mockSession(owner);
    const beforeDelete = await accept(
      byIdClient().getById({
        params: { id: compose.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(beforeDelete.body.id).toBe(compose.composeId);
    await expect(listedComposeIds(owner)).resolves.toContain(compose.composeId);

    mocks.s3.listObjects([]);
    const deleted = await accept(
      byIdClient().delete({
        params: { id: compose.composeId },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(deleted.body).toBeUndefined();

    const afterDelete = await accept(
      byIdClient().getById({
        params: { id: compose.composeId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(afterDelete.body.error.code).toBe("NOT_FOUND");
    await expect(listedComposeIds(owner)).resolves.not.toContain(
      compose.composeId,
    );
  });

  it("returns 404 for another user's compose without hiding it from the owner", async () => {
    const owner = actor("compose_delete_owner_visible");
    const attacker = actor("compose_delete_attacker");
    const compose = await createCompose(owner, "delete-cross-user-compose");

    mockSession(attacker);
    const crossUserDelete = await accept(
      byIdClient().delete({
        params: { id: compose.composeId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(crossUserDelete.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    mockSession(owner);
    const ownerRead = await accept(
      byIdClient().getById({
        params: { id: compose.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(ownerRead.body.id).toBe(compose.composeId);
    await expect(listedComposeIds(owner)).resolves.toContain(compose.composeId);
  });
});
