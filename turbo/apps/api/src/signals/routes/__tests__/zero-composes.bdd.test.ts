import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { composesMainContract } from "@vm0/api-contracts/contracts/composes";
import {
  zeroComposesByIdContract,
  zeroComposesListContract,
  zeroComposesMainContract,
  zeroComposesMetadataContract,
} from "@vm0/api-contracts/contracts/zero-composes";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface ComposeFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly name: string;
  readonly versionId: string;
}

interface TestComposeContent {
  readonly version: string;
  readonly agents: Record<string, { readonly framework: "claude-code" }>;
}

interface ComposeMetadataUpdate {
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly sound?: string | null;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function createClient() {
  return setupApp({ context })(composesMainContract);
}

function byNameClient() {
  return setupApp({ context })(zeroComposesMainContract);
}

function byIdClient() {
  return setupApp({ context })(zeroComposesByIdContract);
}

function listClient() {
  return setupApp({ context })(zeroComposesListContract);
}

function metadataClient() {
  return setupApp({ context })(zeroComposesMetadataContract);
}

function agentName(prefix: string): string {
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

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

async function createCompose(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly name: string;
}): Promise<ComposeFixture> {
  mocks.clerk.session(args.userId, args.orgId);
  const response = await accept(
    createClient().create({
      body: { content: composeContent(args.name) },
      headers: authHeaders(),
    }),
    [201],
  );

  const fixture = {
    userId: args.userId,
    orgId: args.orgId,
    composeId: response.body.composeId,
    name: response.body.name,
    versionId: response.body.versionId,
  };

  return await trackCompose(Promise.resolve(fixture));
}

async function deleteCompose(fixture: ComposeFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  mocks.s3.listObjects([]);
  await accept(
    byIdClient().delete({
      params: { id: fixture.composeId },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

const trackCompose = createFixtureTracker<ComposeFixture>(deleteCompose);

async function updateMetadata(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
  readonly body: ComposeMetadataUpdate;
}): Promise<void> {
  mocks.clerk.session(args.userId, args.orgId);
  const response = await accept(
    metadataClient().update({
      params: { id: args.composeId },
      body: args.body,
      headers: authHeaders(),
    }),
    [200],
  );

  expect(response.body).toStrictEqual({ ok: true });
}

async function listedCompose(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
}) {
  mocks.clerk.session(args.userId, args.orgId);
  const response = await accept(
    listClient().list({ query: {}, headers: authHeaders() }),
    [200],
  );

  return response.body.composes.find((compose) => {
    return compose.id === args.composeId;
  });
}

async function malformedByIdRequest(): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(
    "/api/zero/composes/91fc0bd84bba673393d9adfc1a0f4dec",
    {
      method: "GET",
      headers: authHeaders(),
    },
  );
}

describe("/api/zero/composes BDD", () => {
  it("enforces auth, org, validation, empty-list, and sandbox boundaries", async () => {
    const byName = byNameClient();
    const byId = byIdClient();
    const list = listClient();

    const unauthenticatedByName = await accept(
      byName.getByName({
        query: { name: "any-agent" },
        headers: {},
      }),
      [401],
    );
    const unauthenticatedById = await accept(
      byId.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    const unauthenticatedList = await accept(
      list.list({ query: {}, headers: {} }),
      [401],
    );
    const unauthenticatedMetadata = await accept(
      metadataClient().update({
        params: { id: randomUUID() },
        body: { displayName: "x" },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticatedByName.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedById.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedList.body.error.code).toBe("UNAUTHORIZED");
    expect(unauthenticatedMetadata.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgByName = await accept(
      byName.getByName({
        query: { name: "any-agent" },
        headers: authHeaders(),
      }),
      [401],
    );
    const noOrgById = await accept(
      byId.getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    const noOrgList = await accept(
      list.list({ query: {}, headers: authHeaders() }),
      [400],
    );
    const noOrgMetadata = await accept(
      metadataClient().update({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrgByName.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgById.body.error.code).toBe("UNAUTHORIZED");
    expect(noOrgList.body).toStrictEqual({
      error: { message: "Invalid request", code: "BAD_REQUEST" },
    });
    expect(noOrgMetadata.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });

    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const malformed = await malformedByIdRequest();

    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const emptyUserId = `user_${randomUUID()}`;
    const emptyOrgId = `org_${randomUUID()}`;
    mocks.clerk.session(emptyUserId, emptyOrgId);
    const emptyList = await accept(
      list.list({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(emptyList.body).toStrictEqual({ composes: [] });

    const token = sandboxToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const sandboxList = await accept(
      list.list({
        query: {},
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(sandboxList.body).toStrictEqual({ composes: [] });
  });

  it("creates composes through the API and reads them by name, id, and list", async () => {
    const owner = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const other = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const first = await createCompose({
      ...owner,
      name: agentName("first-agent"),
    });
    const second = await createCompose({
      ...owner,
      name: agentName("second-agent"),
    });
    const otherOrgOnly = await createCompose({
      ...other,
      name: agentName("other-agent"),
    });

    mocks.clerk.session(owner.userId, owner.orgId);
    await accept(
      metadataClient().update({
        params: { id: first.composeId },
        body: {
          displayName: "First Agent",
          description: "first",
          sound: "ding",
        },
        headers: authHeaders(),
      }),
      [200],
    );

    const byId = await accept(
      byIdClient().getById({
        params: { id: first.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(byId.body).toMatchObject({
      id: first.composeId,
      name: first.name,
      headVersionId: first.versionId,
    });
    expect(byId.body.content?.agents[first.name]).toStrictEqual({
      framework: "claude-code",
    });

    const byName = await accept(
      byNameClient().getByName({
        query: { name: first.name },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(byName.body.id).toBe(first.composeId);
    expect(byName.body.headVersionId).toBe(first.versionId);

    const listed = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(
      listed.body.composes.map((compose) => {
        return compose.id;
      }),
    ).toStrictEqual(
      expect.arrayContaining([first.composeId, second.composeId]),
    );
    expect(
      listed.body.composes.map((compose) => {
        return compose.id;
      }),
    ).not.toContain(otherOrgOnly.composeId);
    expect(
      listed.body.composes.find((compose) => {
        return compose.id === first.composeId;
      }),
    ).toMatchObject({
      id: first.composeId,
      name: first.name,
      displayName: "First Agent",
      description: "first",
      sound: "ding",
      headVersionId: first.versionId,
    });

    const missingByName = await accept(
      byNameClient().getByName({
        query: { name: "nonexistent-agent" },
        headers: authHeaders(),
      }),
      [404],
    );
    const missingById = await accept(
      byIdClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    const otherOrgByName = await accept(
      byNameClient().getByName({
        query: { name: otherOrgOnly.name },
        headers: authHeaders(),
      }),
      [404],
    );
    const otherOrgById = await accept(
      byIdClient().getById({
        params: { id: otherOrgOnly.composeId },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missingByName.body).toStrictEqual({
      error: {
        message: "Agent compose not found: nonexistent-agent",
        code: "NOT_FOUND",
      },
    });
    expect(missingById.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
    expect(otherOrgByName.body.error.code).toBe("NOT_FOUND");
    expect(otherOrgById.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });

  it("updates compose metadata through the API and preserves route-visible isolation", async () => {
    const owner = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const outsider = {
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    };
    const fresh = await createCompose({
      ...owner,
      name: agentName("fresh-metadata-agent"),
    });
    const sameOrg = await createCompose({
      ...owner,
      name: agentName("same-org-metadata-agent"),
    });
    const partial = await createCompose({
      ...owner,
      name: agentName("partial-metadata-agent"),
    });

    await updateMetadata({
      ...fresh,
      body: {
        displayName: "Test Display Name",
        description: "Test description",
      },
    });

    const freshListed = await listedCompose(fresh);
    expect(freshListed).toMatchObject({
      id: fresh.composeId,
      displayName: "Test Display Name",
      description: "Test description",
      sound: null,
    });

    const missing = await accept(
      metadataClient().update({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    await updateMetadata({
      ...sameOrg,
      body: {
        displayName: "owner display",
        description: "owner desc",
        sound: "owner sound",
      },
    });
    await updateMetadata({
      userId: `user_${randomUUID()}`,
      orgId: owner.orgId,
      composeId: sameOrg.composeId,
      body: { displayName: "Org-mate Display" },
    });

    const sameOrgListed = await listedCompose(sameOrg);
    expect(sameOrgListed).toMatchObject({
      id: sameOrg.composeId,
      displayName: "Org-mate Display",
      description: "owner desc",
      sound: "owner sound",
    });

    mocks.clerk.session(outsider.userId, outsider.orgId);
    const crossOrg = await accept(
      metadataClient().update({
        params: { id: sameOrg.composeId },
        body: { displayName: "hacked" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    const afterCrossOrg = await listedCompose(sameOrg);
    expect(afterCrossOrg).toMatchObject({
      id: sameOrg.composeId,
      displayName: "Org-mate Display",
      description: "owner desc",
      sound: "owner sound",
    });

    await updateMetadata({
      ...partial,
      body: {
        displayName: "Initial Display",
        description: "Initial description",
        sound: "initial-sound",
      },
    });
    await updateMetadata({
      ...partial,
      body: { displayName: "Updated Display" },
    });

    const partialListed = await listedCompose(partial);
    expect(partialListed).toMatchObject({
      id: partial.composeId,
      displayName: "Updated Display",
      description: "Initial description",
      sound: "initial-sound",
    });

    mocks.clerk.session(outsider.userId, outsider.orgId);
    const outsiderList = await accept(
      listClient().list({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(
      outsiderList.body.composes.map((compose) => {
        return compose.id;
      }),
    ).not.toContain(sameOrg.composeId);
  });
});
