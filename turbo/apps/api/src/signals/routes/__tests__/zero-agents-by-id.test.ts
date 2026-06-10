import { randomUUID } from "node:crypto";

import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { getInstructionsStorageName } from "@vm0/core/storage-names";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { storages } from "@vm0/db/schema/storage";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { generateCliToken, signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedInstructionsStorage$ } from "./helpers/zero-skills";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

// The GET/DELETE agent CRUD and boundary cases have migrated to
// `agent-lifecycle.bdd.test.ts` (API-first BDD). This file retains only the
// cases that cannot be built/observed through the public API: CLI-token and
// zero-token-with-cache auth (GAP-CLI-TOKEN / GAP-ZERO-TOKEN-CACHE), the
// delete-with-real-S3-storage cleanup path, and the pending-run 409 branch
// (GAP-PENDING-RUN) — see `api.bdd.md`.
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function cliAuthHeaders(
  fixture: {
    readonly orgId: string;
    readonly userId: string;
  },
  role: "admin" | "member" = "admin",
): Promise<{ readonly authorization: string }> {
  const tokenId = randomUUID();
  const token = generateCliToken(fixture.userId, fixture.orgId, tokenId);
  const writeDb = store.set(writeDb$);

  await writeDb.insert(cliTokens).values({
    id: tokenId,
    token,
    userId: fixture.userId,
    name: "test token",
    expiresAt: new Date(now() + 60 * 60 * 1000),
  });
  await writeDb
    .insert(orgMembersCache)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      role,
      cachedAt: new Date(now()),
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role, cachedAt: new Date(now()) },
    });

  return { authorization: `Bearer ${token}` };
}

describe("GET /api/zero/agents/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("accepts an owner CLI token for a private agent", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            { displayName: "CLI Private Agent", visibility: "private" },
          ],
        },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture, "member"),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId,
      ownerId: fixture.userId,
      displayName: "CLI Private Agent",
      visibility: "private",
    });
  });

  it("returns the agent for a zero token with agent:read capability", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Zero Token Agent",
              description: "Read by zero token",
            },
          ],
        },
        context.signal,
      ),
    );
    const agentId = fixture.composeIds[0]!;
    const runId = `run_${randomUUID()}`;
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: fixture.userId,
      orgId: fixture.orgId,
      runId,
      capabilities: ["agent:read"],
      iat: seconds,
      exp: seconds + 60,
    });
    await store
      .set(writeDb$)
      .insert(orgMembersCache)
      .values({
        orgId: fixture.orgId,
        userId: fixture.userId,
        role: "admin",
        cachedAt: new Date(now()),
      });

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.get({
        params: { id: agentId },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      agentId,
      ownerId: fixture.userId,
      displayName: "Zero Token Agent",
      description: "Read by zero token",
    });
  });
});

describe("DELETE /api/zero/agents/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("deletes an agent that has no instructions storage", async () => {
    // A `seedTeamCompose` agent has no instructions-storage row, exercising the
    // storage-less delete branch of `deleteComposeById$` that API-created
    // agents (which always provision instructions storage) cannot reach.
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    const writeDb = store.set(writeDb$);
    await expect(
      writeDb
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId)),
    ).resolves.toStrictEqual([]);
    await expect(
      writeDb
        .select({ id: agentComposes.id })
        .from(agentComposes)
        .where(eq(agentComposes.id, agentId)),
    ).resolves.toStrictEqual([]);
  });

  it("allows an owner CLI token to delete and cleans instructions storage", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    const agentName = `agent-${agentId.slice(0, 8)}`;
    const storageName = getInstructionsStorageName(agentName);
    const s3Prefix = `orgs/${fixture.orgId}/${storageName}`;
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName,
        s3Key: `${s3Prefix}/v1`,
      },
      context.signal,
    );
    mocks.s3.listObjects([
      {
        bucket: "test-user-storages",
        key: `${s3Prefix}/v1/archive.tar.gz`,
        size: 1024,
      },
    ]);

    const writeDb = store.set(writeDb$);
    await expect(
      writeDb
        .select({ id: storages.id })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, fixture.orgId),
            eq(storages.name, storageName),
          ),
        ),
    ).resolves.toHaveLength(1);

    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: await cliAuthHeaders(fixture, "member"),
      }),
      [204],
    );
    expect(response.body).toBeUndefined();

    await expect(
      writeDb
        .select({ id: storages.id })
        .from(storages)
        .where(
          and(
            eq(storages.orgId, fixture.orgId),
            eq(storages.name, storageName),
          ),
        ),
    ).resolves.toStrictEqual([]);
  });

  it("returns 409 and preserves rows when a pending run references the agent", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const agentId = fixture.composeIds[0];
    if (!agentId) {
      throw new Error("Expected seeded agent");
    }
    const writeDb = store.set(writeDb$);
    const versionId = `v_${randomUUID().slice(0, 16)}`;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await writeDb.insert(agentComposeVersions).values({
      id: versionId,
      composeId: agentId,
      content: {},
      createdBy: fixture.userId,
    });
    await writeDb.insert(agentSessions).values({
      id: sessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: agentId,
    });
    await writeDb.insert(agentRuns).values({
      id: runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: versionId,
      sessionId,
      status: "pending",
      prompt: "x",
    });

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroAgentsByIdContract);
    const response = await accept(
      client.delete({
        params: { id: agentId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [409],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
    await expect(
      writeDb
        .select({ id: zeroAgents.id })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, agentId)),
    ).resolves.toStrictEqual([{ id: agentId }]);
    await expect(
      writeDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([{ id: runId }]);

    await writeDb.delete(agentRuns).where(eq(agentRuns.id, runId));
    await writeDb.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await writeDb
      .delete(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId));
  });
});
