import { randomUUID } from "node:crypto";

import { command, createStore } from "ccstate";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";
import {
  getCustomSkillStorageName,
  getInstructionsStorageName,
} from "@vm0/core/storage-names";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { storages } from "@vm0/db/schema/storage";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

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

describe("DELETE /api/agent/composes/:id", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(cleanupAgentComposeFixture$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns the web-compatible sandbox deletion error", async () => {
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 60,
    });
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns the web-compatible zero token deletion error", async () => {
    const seconds = currentSecond();
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mockUserOrganizationMembership(userId, orgId);
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent:delete"],
      iat: seconds,
      exp: seconds + 60,
    });
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Agent deletion is not available from sandbox",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for malformed compose id", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      "/api/agent/composes/91fc0bd84bba673393d9adfc1a0f4dec",
      {
        method: "DELETE",
        headers: { authorization: "Bearer clerk-session" },
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("deletes the owner's compose when no instructions volume exists", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    const db = store.set(writeDb$);
    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    expect(composeRows).toHaveLength(0);
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown id", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 for a non-owner and keeps the compose", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    const db = store.set(writeDb$);
    const [survivor] = await db
      .select({ userId: agentComposes.userId })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    expect(survivor?.userId).toBe(fixture.userId);
  });

  it("returns 409 when a pending run references the compose", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const db = store.set(writeDb$);
    const versionId = `v_${randomUUID().slice(0, 16)}`;
    const sessionId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: {},
      createdBy: fixture.userId,
    });
    await db.insert(agentSessions).values({
      id: sessionId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: composeId,
    });
    await db.insert(agentRuns).values({
      id: runId,
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeVersionId: versionId,
      sessionId,
      status: "pending",
      prompt: "x",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: composeId },
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
    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(eq(agentComposes.id, composeId));
    expect(composeRows).toHaveLength(1);
    const runRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(runRows).toHaveLength(1);
  });

  it("deletes instructions volume and S3 objects", async () => {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", BUCKET);
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const agentName = `agent-${composeId.slice(0, 8)}`;
    const storageName = getInstructionsStorageName(agentName);
    await store.set(
      seedInstructionsStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentName,
        s3Key: "unused",
      },
      context.signal,
    );
    const storageBefore = await findStorage(fixture.orgId, storageName);
    expect(storageBefore).not.toBeNull();
    const prefix = storageBefore?.s3Prefix ?? "";
    mocks.s3.listObjects([
      { bucket: BUCKET, key: `${prefix}/v1/archive.tar.gz`, size: 1024 },
      { bucket: BUCKET, key: `${prefix}/v1/manifest.json`, size: 256 },
    ]);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(findStorage(fixture.orgId, storageName)).resolves.toBeNull();
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
  });

  it("does not delete unrelated skill volumes", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, { composes: [{}] }, context.signal),
    );
    const composeId = fixture.composeIds[0];
    if (!composeId) {
      throw new Error("Expected seeded compose");
    }
    const skillName = `skill-${randomUUID().slice(0, 8)}`;
    await store.set(
      seedSkillStorage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        skillName,
        s3Key: "unused",
        headVersionId: `head-${randomUUID().slice(0, 16)}`,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(composesByIdContract);

    const response = await accept(
      client.delete({
        params: { id: composeId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [204],
    );

    expect(response.body).toBeUndefined();
    await expect(
      findStorage(fixture.orgId, getCustomSkillStorageName(skillName)),
    ).resolves.not.toBeNull();
  });
});
