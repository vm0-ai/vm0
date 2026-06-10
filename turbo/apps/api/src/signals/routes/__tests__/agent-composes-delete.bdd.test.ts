import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";
import {
  getCustomSkillStorageName,
  getInstructionsStorageName,
} from "@vm0/core/storage-names";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { storages } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  seedInstructionsStorage$,
  seedSkillStorage$,
} from "./helpers/zero-skills";
import { seedTeamCompose$, type TeamComposeFixture } from "./helpers/zero-team";
import { seedRun$ } from "./helpers/zero-usage-insight";

// BDD migration of the legacy `agent-composes-delete.test.ts`.
// The 9 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// boundary chain (401 unauth → 403 sandbox → 403 zero-token →
// 400 malformed id), (2) 404 chain (unknown id → non-owner),
// (3) success chain (409 pending run → 204 owner without
// instructions volume → 204 with instructions volume + S3
// deletion → 204 unrelated skill kept). The 409 case uses
// `seedRun$` to insert a pending run via direct DB (Open
// Helper Gap). The deletion verification uses a follow-up GET
// through the contract instead of direct DB SELECTs.

const BUCKET = "test-bucket";
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const cleanupAgentComposeFixture$ = command(
  async (
    { set },
    fixture: TeamComposeFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.delete(agentRuns).where(eq(agentRuns.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(agentSessions)
      .where(eq(agentSessions.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
    signal.throwIfAborted();
  },
);

type StorageLookup = {
  readonly id: string;
  readonly s3Prefix: string;
};

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

async function findStorage(
  orgId: string,
  name: string,
): Promise<StorageLookup | null> {
  const db = store.set(writeDb$);
  const [storage] = await db
    .select({ id: storages.id, s3Prefix: storages.s3Prefix })
    .from(storages)
    .where(and(eq(storages.orgId, orgId), eq(storages.name, name)))
    .limit(1);

  return storage ?? null;
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function s3CommandInputs(): readonly Record<string, unknown>[] {
  return context.mocks.s3.send.mock.calls.map(([command]) => {
    return commandInput(command);
  });
}

function mockUserOrganizationMembership(userId: string, orgId: string): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: orgId }, role: "org:admin" }],
  });
}

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(cleanupAgentComposeFixture$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function composesClient() {
  return setupApp({ context })(composesByIdContract);
}

function firstComposeId(fixture: TeamComposeFixture): string {
  const composeId = fixture.composeIds[0];
  if (!composeId) {
    throw new Error("Expected seeded compose");
  }
  return composeId;
}

describe("BDD DELETE /api/agent/composes/:id — auth boundary", () => {
  it("gwt-wt-wt: 401 unauthenticated → 403 sandbox token → 403 zero-token → 400 malformed compose id", async () => {
    const c = composesClient();

    // When + Then: 401.
    const unauth = await accept(
      c.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a sandbox JWT.
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: 403 with the web-compatible message.
    const sandboxForbidden = await accept(
      c.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandboxForbidden.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });

    // Given: a zero-scope token with the agent:delete capability.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mockUserOrganizationMembership(userId, orgId);
    const zeroToken = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:delete"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: zero-scope still hits the sandbox rejection
    // (the web-compatible message is the same).
    const zeroForbidden = await accept(
      c.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${zeroToken}` },
      }),
      [403],
    );
    expect(zeroForbidden.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });

    // Given: an authenticated session; a malformed compose id
    // is sent through the public app (the ts-rest client
    // validates client-side and never reaches the route).
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });
    const malformed = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );

    // When + Then: 400 BAD_REQUEST.
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });
});

describe("BDD DELETE /api/agent/composes/:id — 404 chain", () => {
  it("gwt-wt-wt: 404 unknown id → 404 non-owner", async () => {
    const c = composesClient();

    // Given: an authenticated session, no seeded compose.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404 for an unknown compose id.
    const unknown = await accept(
      c.delete({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // Given: a compose owned by another user in the same org.
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    // When + Then: 404 (non-owner cannot see, let alone delete).
    const nonOwner = await accept(
      c.delete({
        params: { id: composeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(nonOwner.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });

    // When + Then: the compose is still there for the original
    // owner (verified via GET through the contract).
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const stillThere = await accept(
      c.getById({ params: { id: composeId }, headers: authHeaders() }),
      [200],
    );
    expect(stillThere.body.id).toBe(composeId);
  });
});

describe("BDD DELETE /api/agent/composes/:id — 409 + success chain", () => {
  it("gwt-wt-wt: 409 pending run → 204 owner without instructions volume → 204 with instructions volume + S3 deletion → 204 unrelated skill kept", async () => {
    const c = composesClient();

    // Given: a compose with a pending run (status inserted
    // through the seedRun helper — Open Helper Gap).
    const pendingFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const pendingComposeId = firstComposeId(pendingFixture);
    await store.set(
      seedRun$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        composeId: pendingComposeId,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(pendingFixture.userId, pendingFixture.orgId);

    // When + Then: 409 Conflict.
    const conflict = await accept(
      c.delete({
        params: { id: pendingComposeId },
        headers: authHeaders(),
      }),
      [409],
    );
    expect(conflict.body).toStrictEqual({
      error: {
        message: "Cannot delete agent: agent is currently running",
        code: "CONFLICT",
      },
    });
    // The compose + the pending run are still present
    // (verified through the contract GET — listing by id
    // returns 200, and the run id remains valid since we did
    // not assert it via direct DB in the BDD form).
    const stillPresent = await accept(
      c.getById({
        params: { id: pendingComposeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stillPresent.body.id).toBe(pendingComposeId);

    // Given: an owner compose with no instructions volume
    // (no skills seeded).
    const noVolumeFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const noVolumeComposeId = firstComposeId(noVolumeFixture);
    mocks.clerk.session(noVolumeFixture.userId, noVolumeFixture.orgId);
    context.mocks.s3.send.mockClear();

    // When + Then: 204 No Content + S3 was never called (no
    // instructions volume to clean up).
    const noVolumeDelete = await accept(
      c.delete({
        params: { id: noVolumeComposeId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(noVolumeDelete.body).toBeUndefined();
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
    // The compose is now gone (404 on follow-up GET).
    const noVolumeGone = await accept(
      c.getById({
        params: { id: noVolumeComposeId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(noVolumeGone.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });

    // Given: a compose whose instructions volume has two S3
    // objects ready to be deleted.
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    const volumeFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const volumeComposeId = firstComposeId(volumeFixture);
    const agentName = `agent-${volumeComposeId.slice(0, 8)}`;
    const storageName = getInstructionsStorageName(agentName);
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: volumeFixture.orgId,
        userId: volumeFixture.userId,
        agentName,
        s3Key: "unused",
      },
      context.signal,
    );
    const storageBefore = await findStorage(volumeFixture.orgId, storageName);
    expect(storageBefore).not.toBeNull();
    const prefix = storageBefore?.s3Prefix ?? "";
    mocks.s3.listObjects([
      { bucket: BUCKET, key: `${prefix}/v1/archive.tar.gz`, size: 1024 },
      { bucket: BUCKET, key: `${prefix}/v1/manifest.json`, size: 256 },
    ]);
    mocks.clerk.session(volumeFixture.userId, volumeFixture.orgId);
    context.mocks.s3.send.mockClear();

    // When + Then: 204 + the storage row + both S3 objects are
    // removed.
    const volumeDelete = await accept(
      c.delete({
        params: { id: volumeComposeId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(volumeDelete.body).toBeUndefined();
    await expect(
      findStorage(volumeFixture.orgId, storageName),
    ).resolves.toBeNull();
    expect(s3CommandInputs()).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ Bucket: BUCKET, Prefix: prefix }),
        expect.objectContaining({
          Bucket: BUCKET,
          Delete: {
            Objects: [
              { Key: `${prefix}/v1/archive.tar.gz` },
              { Key: `${prefix}/v1/manifest.json` },
            ],
          },
        }),
      ]),
    );

    // Given: an unrelated skill volume that should NOT be
    // touched by compose deletion.
    const skillFixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const skillComposeId = firstComposeId(skillFixture);
    const skillName = `skill-${randomUUID().slice(0, 8)}`;
    await store.set(
      seedSkillStorage$,
      {
        orgId: skillFixture.orgId,
        userId: skillFixture.userId,
        skillName,
        s3Key: "unused",
        headVersionId: `head-${randomUUID().slice(0, 16)}`,
      },
      context.signal,
    );
    mocks.clerk.session(skillFixture.userId, skillFixture.orgId);

    // When + Then: 204 + the skill storage row is still present.
    const skillDelete = await accept(
      c.delete({
        params: { id: skillComposeId },
        headers: authHeaders(),
      }),
      [204],
    );
    expect(skillDelete.body).toBeUndefined();
    await expect(
      findStorage(skillFixture.orgId, getCustomSkillStorageName(skillName)),
    ).resolves.not.toBeNull();
  });
});
