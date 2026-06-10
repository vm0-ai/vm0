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

// BDD migration of the legacy "agent-sessions-id.test.ts". The
// 8 legacy cases collapse into 3 BDD chains: (1) auth
// boundary (401 unauth -> 404 no-org), (2) 404/403 chain
// (missing -> other user in same org -> other org), (3) 200
// success chain (runtime org beats compose org -> compose org
// denied -> with artifacts + secret refs returns details ->
// no secret refs returns null secretNames). The session id is
// reached through the seedCompose + seedRun + sessionIdForRun
// helper which reads agentRuns.sessionId; the session id of a
// completed run is generated server-side (Open Helper Gap).

interface SessionSeedResult {
  readonly composeId: string;
  readonly sessionId: string;
}

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

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function sessionsClient() {
  return setupApp({ context })(sessionsByIdContract);
}

function secretReference(name: string): string {
  return `\${{ secrets.${name} }}`;
}

async function seedSession(
  fixture: UsageInsightFixture,
): Promise<SessionSeedResult> {
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

describe("BDD GET /api/agent/sessions/:id — auth boundary", () => {
  it("gwt-wt-wt: 401 unauthenticated → 404 no active organization", async () => {
    // When + Then: 401.
    const unauth = await accept(
      sessionsClient().getById({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with no org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: 404 (the route hides the no-org case as a
    // not-found rather than a 401/403).
    const noOrg = await accept(
      sessionsClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/agent/sessions/:id — 404/403 chain", () => {
  it("gwt-wt-wt: 404 missing session → 403 session from another user in same org → 404 session from another org", async () => {
    // Given: a session.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 missing.
    const missing = await accept(
      sessionsClient().getById({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });

    // Given: a session owned by the fixture's user/org + a
    // different user in the same org.
    const { sessionId } = await seedSession(fixture);
    mocks.clerk.session(`user_${randomUUID()}`, fixture.orgId);

    // When + Then: 403 (peer user is forbidden).
    const otherUser = await accept(
      sessionsClient().getById({
        params: { id: sessionId },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(otherUser.body).toStrictEqual({
      error: {
        message: "You do not have permission to access this session",
        code: "FORBIDDEN",
      },
    });

    // Given: the fixture's user but a different org.
    mocks.clerk.session(fixture.userId, `org_${randomUUID()}`);

    // When + Then: 404 (cross-org is hidden as not-found).
    const otherOrg = await accept(
      sessionsClient().getById({
        params: { id: sessionId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(otherOrg.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/agent/sessions/:id — 200 success chain", () => {
  it("gwt-wt-wt: 200 runtime org beats compose org (allowed) → compose org denied → with artifacts + secret refs returns details → no secret refs returns null secretNames", async () => {
    // Given: a compose owned by composeFixture + a run executed
    // in runtimeFixture's org (cross-org run).
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

    // When + Then: the runtime org can read the session.
    mocks.clerk.session(runtimeFixture.userId, runtimeFixture.orgId);
    const allowed = await accept(
      sessionsClient().getById({
        params: { id: sessionId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(allowed.body.id).toBe(sessionId);

    // When + Then: the compose org cannot (authorization is
    // by the runtime org, not the compose owner).
    mocks.clerk.session(composeFixture.userId, composeFixture.orgId);
    const denied = await accept(
      sessionsClient().getById({
        params: { id: sessionId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(denied.body).toStrictEqual({
      error: { message: "Session not found", code: "NOT_FOUND" },
    });

    // Given: a separate session whose compose head declares
    // two secret references and whose session row carries
    // two artifacts.
    const detailFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId, sessionId: detailSessionId } =
      await seedSession(detailFixture);
    await store.set(
      updateSessionArtifacts$,
      {
        sessionId: detailSessionId,
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
    mocks.clerk.session(detailFixture.userId, detailFixture.orgId);

    // When + Then: the response carries the artifact names and
    // the resolved secret names from the compose head.
    const detail = await accept(
      sessionsClient().getById({
        params: { id: detailSessionId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(detail.body).toMatchObject({
      id: detailSessionId,
      agentComposeId: composeId,
      conversationId: null,
      artifactNames: ["frontend", "backend"],
      secretNames: ["API_TOKEN", "GH_TOKEN"],
    });
    expect(Number.isNaN(Date.parse(detail.body.createdAt))).toBeFalsy();
    expect(Number.isNaN(Date.parse(detail.body.updatedAt))).toBeFalsy();

    // Given: another session whose compose head has no secret
    // references.
    const noSecretFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: noSecretComposeId, sessionId: noSecretSessionId } =
      await seedSession(noSecretFixture);
    mocks.clerk.session(noSecretFixture.userId, noSecretFixture.orgId);

    // When + Then: secretNames is null when the compose head
    // has no secret references.
    const noSecretResponse = await accept(
      sessionsClient().getById({
        params: { id: noSecretSessionId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(noSecretResponse.body.agentComposeId).toBe(noSecretComposeId);
    expect(noSecretResponse.body.artifactNames).toStrictEqual([]);
    expect(noSecretResponse.body.secretNames).toBeNull();
  });
});
