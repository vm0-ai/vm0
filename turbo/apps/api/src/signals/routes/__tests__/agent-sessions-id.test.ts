import { randomUUID } from "node:crypto";

import { sessionsByIdContract } from "@vm0/api-contracts/contracts/sessions";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import type { ContextArtifact } from "@vm0/db/types";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const sessionIdForRun$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<string> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({ sessionId: agentRuns.sessionId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      throw new Error("sessionIdForRun$: run not found");
    }
    return row.sessionId;
  },
);

const updateSessionArtifacts$ = command(
  async (
    { set },
    args: { readonly sessionId: string; readonly artifacts: ContextArtifact[] },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(agentSessions)
      .set({ artifacts: args.artifacts })
      .where(eq(agentSessions.id, args.sessionId));
    signal.throwIfAborted();
  },
);

const updateComposeHeadContent$ = command(
  async (
    { set },
    args: { readonly composeId: string; readonly content: unknown },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [compose] = await db
      .select({ headVersionId: agentComposes.headVersionId })
      .from(agentComposes)
      .where(eq(agentComposes.id, args.composeId))
      .limit(1);
    signal.throwIfAborted();
    if (!compose?.headVersionId) {
      throw new Error("updateComposeHeadContent$: compose head not found");
    }

    await db
      .update(agentComposeVersions)
      .set({ content: args.content })
      .where(eq(agentComposeVersions.id, compose.headVersionId));
    signal.throwIfAborted();
  },
);

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function secretReference(name: string): string {
  return `\${{ secrets.${name} }}`;
}

async function seedSession(
  fixture: UsageInsightFixture,
): Promise<{ readonly composeId: string; readonly sessionId: string }> {
  const compose = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: compose.composeId,
      status: "completed",
    },
    context.signal,
  );
  const sessionId = await store.set(sessionIdForRun$, runId, context.signal);
  return { composeId: compose.composeId, sessionId };
}

describe("GET /api/agent/sessions/:id", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when the session does not exist", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });

  it("returns 403 when the session belongs to another user", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { sessionId } = await seedSession(fixture);
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "You do not have permission to access this session",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 404 when the session belongs to another organization", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { sessionId } = await seedSession(fixture);
    mocks.clerk.session(fixture.userId, `org_${randomUUID()}`);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });

  it("authorizes by session runtime organization rather than compose organization", async () => {
    const composeFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const runtimeFixture = await track(
      Promise.resolve({
        orgId: `org_${randomUUID()}`,
        userId: composeFixture.userId,
      }),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: composeFixture.orgId, userId: composeFixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: runtimeFixture.orgId,
        userId: runtimeFixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );
    const sessionId = await store.set(sessionIdForRun$, runId, context.signal);
    const client = setupApp({ context })(sessionsByIdContract);

    mocks.clerk.session(runtimeFixture.userId, runtimeFixture.orgId);
    const allowed = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(allowed.body.id).toBe(sessionId);

    mocks.clerk.session(composeFixture.userId, composeFixture.orgId);
    const denied = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );
    expect(denied.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });

  it("returns session details with artifacts and required secret names", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId, sessionId } = await seedSession(fixture);
    await store.set(
      updateSessionArtifacts$,
      {
        sessionId,
        artifacts: [
          { name: "frontend", version: "v-fe-1", mountPath: "/workspace/fe" },
          { name: "backend", version: "v-be-2", mountPath: "/workspace/be" },
        ],
      },
      context.signal,
    );
    await store.set(
      updateComposeHeadContent$,
      {
        composeId,
        content: {
          version: "1.0",
          agents: {
            "test-agent": {
              framework: "claude-code",
              env: {
                API_KEY: secretReference("API_TOKEN"),
                GITHUB_TOKEN: secretReference("GH_TOKEN"),
              },
            },
          },
        },
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      id: sessionId,
      agentComposeId: composeId,
      conversationId: null,
      artifactNames: ["frontend", "backend"],
      secretNames: ["API_TOKEN", "GH_TOKEN"],
    });
    expect(Number.isNaN(Date.parse(response.body.createdAt))).toBeFalsy();
    expect(Number.isNaN(Date.parse(response.body.updatedAt))).toBeFalsy();
  });

  it("returns null secret names when the compose head has no secret references", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId, sessionId } = await seedSession(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(sessionsByIdContract);

    const response = await accept(
      client.getById({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.agentComposeId).toBe(composeId);
    expect(response.body.artifactNames).toStrictEqual([]);
    expect(response.body.secretNames).toBeNull();
  });
});
