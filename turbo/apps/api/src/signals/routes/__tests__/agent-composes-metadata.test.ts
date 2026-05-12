import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { composesMetadataContract } from "@vm0/api-contracts/contracts/composes";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function firstComposeId(fixture: TeamComposeFixture): string {
  const composeId = fixture.composeIds[0];
  if (!composeId) {
    throw new Error("Expected seeded compose");
  }
  return composeId;
}

async function patchMetadataRaw(
  composeId: string,
  body: Record<string, unknown>,
  headers: HeadersInit,
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(`/api/agent/composes/${composeId}/metadata`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/agent/composes/:id/metadata", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(composesMetadataContract);

    const response = await accept(
      client.updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "x" },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 400 for invalid body", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchMetadataRaw(
      composeId,
      { displayName: 12_345 },
      { authorization: "Bearer clerk-session" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  it("returns 400 without an active organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "No Org" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Explicit org context required — ensure active org in session",
      },
    });
  });

  it("creates zero_agents row when none exists", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: composeId },
        body: {
          displayName: "My Agent",
          description: "A test agent",
          sound: "friendly",
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("My Agent");
    expect(row?.description).toBe("A test agent");
    expect(row?.sound).toBe("friendly");
  });

  it("updates existing zero_agents row and preserves omitted fields", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        {
          composes: [
            {
              displayName: "Old Name",
              description: "Old description",
              sound: "old-sound",
            },
          ],
        },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: composeId },
        body: { displayName: "New Name" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ ok: true });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        displayName: zeroAgents.displayName,
        description: zeroAgents.description,
        sound: zeroAgents.sound,
      })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, composeId));
    expect(row?.displayName).toBe("New Name");
    expect(row?.description).toBe("Old description");
    expect(row?.sound).toBe("old-sound");
  });

  it("returns 404 for nonexistent compose", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: randomUUID() },
        body: { displayName: "Test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Agent compose not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 for compose owned by another org", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(
      `user_${randomUUID()}`,
      `org_${randomUUID().slice(0, 8)}`,
    );

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: composeId },
        body: { displayName: "Hacked Name" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("allows same-org member to update metadata", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: composeId },
        body: { displayName: "Updated by member" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
  });

  it("allows sandbox tokens to update same-org metadata", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ withZeroAgent: false }] },
        context.signal,
      ),
    );
    const composeId = firstComposeId(fixture);
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: fixture.orgId,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(composesMetadataContract);
    const response = await accept(
      client.updateMetadata({
        params: { id: composeId },
        body: { sound: "sandbox-sound" },
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ ok: true });
  });
});
