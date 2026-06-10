import { randomUUID } from "node:crypto";

import { chatThreadGithubPrsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userConnectors } from "@vm0/db/schema/user-connector";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { encryptSecretForTests } from "./helpers/encrypt-secret";
import {
  deleteZeroChatThread$,
  seedZeroChatMessage$,
  seedZeroChatThread$,
  type ZeroChatThreadFixture,
} from "./helpers/zero-chat-threads";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-chat-threads-github-prs.test.ts`.
// The legacy direct DB SELECTs that verified connector / feature
// switch presence are replaced by assertions on the public list
// contract's `prs` array. The "agent not authorized" and "feature
// switch off" cases share the same precondition (GitHub connector
// seeded, agent has no grant or feature switch disabled) and are
// exercised through a single chain step. The 6 legacy `it()`s
// collapse into 2 BDD `it()`s (auth boundary + a PR check chain).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

type GithubConnectorScope = {
  readonly orgId: string;
  readonly userId: string;
};

async function seedGithubConnector(args: {
  readonly fixture: ZeroChatThreadFixture;
  readonly authorizeAgent?: boolean;
  readonly enableFeature?: boolean;
}): Promise<GithubConnectorScope> {
  const writeDb = store.set(writeDb$);
  const switches: Record<string, boolean> =
    args.enableFeature === false
      ? {}
      : { [FeatureSwitchKey.ChatGithubPrTracking]: true };

  if (Object.keys(switches).length > 0) {
    await writeDb.insert(userFeatureSwitches).values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      switches,
    });
  }

  await writeDb.insert(connectors).values({
    orgId: args.fixture.orgId,
    userId: args.fixture.userId,
    type: "github",
    authMethod: "oauth",
    externalId: `github-${randomUUID()}`,
    externalUsername: "octocat",
  });
  await writeDb.insert(secrets).values({
    orgId: args.fixture.orgId,
    userId: args.fixture.userId,
    name: "GITHUB_ACCESS_TOKEN",
    type: "connector",
    encryptedValue: encryptSecretForTests("gho_test_token"),
  });

  if (args.authorizeAgent !== false) {
    await writeDb.insert(userConnectors).values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      agentId: args.fixture.composeId,
      connectorType: "github",
    });
  }

  return {
    orgId: args.fixture.orgId,
    userId: args.fixture.userId,
  };
}

async function deleteGithubConnectorRows(
  scope: GithubConnectorScope,
): Promise<void> {
  const writeDb = store.set(writeDb$);
  const filter = and(
    eq(connectors.orgId, scope.orgId),
    eq(connectors.userId, scope.userId),
  );
  await Promise.all([
    writeDb
      .delete(userConnectors)
      .where(
        and(
          eq(userConnectors.orgId, scope.orgId),
          eq(userConnectors.userId, scope.userId),
        ),
      ),
    writeDb
      .delete(userFeatureSwitches)
      .where(
        and(
          eq(userFeatureSwitches.orgId, scope.orgId),
          eq(userFeatureSwitches.userId, scope.userId),
        ),
      ),
    writeDb
      .delete(secrets)
      .where(
        and(eq(secrets.orgId, scope.orgId), eq(secrets.userId, scope.userId)),
      ),
    writeDb.delete(connectors).where(filter),
  ]);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function listClient() {
  return setupApp({ context })(chatThreadGithubPrsContract);
}

describe("BDD GET /api/zero/chat-threads/:threadId/github-prs — auth boundary", () => {
  it("returns 401 when unauthenticated", async () => {
    // When + Then: no auth header → 401.
    const response = await accept(
      listClient().list({
        params: { threadId: randomUUID() },
        headers: {},
      }),
      [401],
    );
    expect(response.body.error.message).toContain("Not authenticated");
  });
});

const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
  return store.set(deleteZeroChatThread$, fixture, context.signal);
});
const trackGithubConnector = createFixtureTracker<GithubConnectorScope>(
  deleteGithubConnectorRows,
);

describe("BDD GET /api/zero/chat-threads/:threadId/github-prs — PR check chain", () => {
  it("gwt-wt-wt: 403 agent not authorized → 403 feature switch off → 404 malformed threadId → 200 PR with checks (success rollup) → 200 PR with conflicts (mergeStatus: conflicts) → 200 PR with pending rollup (no check runs)", async () => {
    const c = listClient();

    // Given: a thread whose agent has not authorized the GitHub
    // connector (connector + secret seeded, but no userConnectors
    // grant for the agent).
    const noAuthFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(
      seedGithubConnector({ fixture: noAuthFixture, authorizeAgent: false }),
    );
    mocks.clerk.session(noAuthFixture.userId, noAuthFixture.orgId);

    // When + Then: 403.
    const noAuth = await accept(
      c.list({
        params: { threadId: noAuthFixture.threadId },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(noAuth.body.error.message).toBe(
      "GitHub connector is not authorized for this agent",
    );

    // Given: a thread whose user has the connector but the feature
    // switch is off.
    const noFeatureFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(
      seedGithubConnector({
        fixture: noFeatureFixture,
        enableFeature: false,
      }),
    );
    mocks.clerk.session(noFeatureFixture.userId, noFeatureFixture.orgId);

    // When + Then: 403.
    const noFeature = await accept(
      c.list({
        params: { threadId: noFeatureFixture.threadId },
        headers: authHeaders(),
      }),
      [403],
    );
    expect(noFeature.body.error.message).toBe(
      "GitHub PR tracking is not enabled",
    );

    // Given: a fully authorized thread.
    const okFixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(seedGithubConnector({ fixture: okFixture }));
    mocks.clerk.session(okFixture.userId, okFixture.orgId);

    // When + Then: 404 for a malformed threadId.
    const malformed = await accept(
      c.list({
        params: { threadId: "not-a-uuid" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(malformed.body.error.message).toBe("Chat thread not found");

    // Given: an assistant message mentioning a PR + a GitHub mock
    // returning ready checks.
    await store.set(
      seedZeroChatMessage$,
      okFixture,
      {
        role: "assistant",
        content:
          "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
      },
      context.signal,
    );
    server.use(
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/pulls/15070",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer gho_test_token",
          );
          return HttpResponse.json({
            title: "Add GitHub PR tracking",
            html_url: "https://github.com/vm0-ai/vm0/pull/15070",
            state: "open",
            merged_at: null,
            draft: false,
            mergeable: true,
            mergeable_state: "clean",
            head: { sha: "abc123" },
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/abc123/check-runs",
        () => {
          return HttpResponse.json({
            check_runs: [
              {
                name: "CI",
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/vm0-ai/vm0/actions/runs/1",
                started_at: "2026-06-02T00:00:00Z",
                completed_at: "2026-06-02T00:01:00Z",
              },
            ],
          });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/abc123/status",
        () => {
          return HttpResponse.json({ state: "success", statuses: [] });
        },
      ),
    );

    // When + Then: the public list reports the PR with `mergeStatus:
    // ready` and `rollup: success`.
    const success = await accept(
      c.list({
        params: { threadId: okFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(success.body.prs).toStrictEqual([
      {
        repo: "vm0-ai/vm0",
        number: 15_070,
        title: "Add GitHub PR tracking",
        url: "https://github.com/vm0-ai/vm0/pull/15070",
        state: "open",
        headSha: "abc123",
        mergeStatus: "ready",
        rollup: "success",
        checks: [
          {
            name: "CI",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/vm0-ai/vm0/actions/runs/1",
            startedAt: "2026-06-02T00:00:00Z",
            completedAt: "2026-06-02T00:01:00Z",
          },
        ],
      },
    ]);

    // Given: a different PR with a conflict merge state.
    await store.set(
      seedZeroChatMessage$,
      okFixture,
      {
        role: "assistant",
        content:
          "Review https://github.com/vm0-ai/vm0/pull/15071 before merging.",
      },
      context.signal,
    );
    server.use(
      http.get("https://api.github.com/repos/vm0-ai/vm0/pulls/15071", () => {
        return HttpResponse.json({
          title: "Update PR tracking merge status",
          html_url: "https://github.com/vm0-ai/vm0/pull/15071",
          state: "open",
          merged_at: null,
          draft: false,
          mergeable: false,
          mergeable_state: "dirty",
          head: { sha: "def456" },
        });
      }),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/def456/check-runs",
        () => {
          return HttpResponse.json({ check_runs: [] });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/def456/status",
        () => {
          return HttpResponse.json({ state: "success", statuses: [] });
        },
      ),
    );

    // When + Then: the list reports `mergeStatus: conflicts` and
    // `rollup: none` for the conflict PR.
    const conflicts = await accept(
      c.list({
        params: { threadId: okFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    const conflictPr = conflicts.body.prs.find((p) => {
      return p.number === 15_071;
    });
    expect(conflictPr).toMatchObject({
      repo: "vm0-ai/vm0",
      number: 15_071,
      mergeStatus: "conflicts",
      rollup: "none",
    });

    // Given: a third PR with no check runs but a pending status.
    await store.set(
      seedZeroChatMessage$,
      okFixture,
      {
        role: "assistant",
        content:
          "Review https://github.com/vm0-ai/vm0/pull/15072 before merging.",
      },
      context.signal,
    );
    server.use(
      http.get("https://api.github.com/repos/vm0-ai/vm0/pulls/15072", () => {
        return HttpResponse.json({
          title: "Wait for pending checks",
          html_url: "https://github.com/vm0-ai/vm0/pull/15072",
          state: "open",
          merged_at: null,
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "ghi789" },
        });
      }),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/ghi789/check-runs",
        () => {
          return HttpResponse.json({ check_runs: [] });
        },
      ),
      http.get(
        "https://api.github.com/repos/vm0-ai/vm0/commits/ghi789/status",
        () => {
          return HttpResponse.json({ state: "pending", statuses: [] });
        },
      ),
    );

    // When + Then: the list reports `mergeStatus: null` and
    // `rollup: pending` with a synthetic `GitHub status` check.
    const pending = await accept(
      c.list({
        params: { threadId: okFixture.threadId },
        headers: authHeaders(),
      }),
      [200],
    );
    const pendingPr = pending.body.prs.find((p) => {
      return p.number === 15_072;
    });
    expect(pendingPr).toMatchObject({
      repo: "vm0-ai/vm0",
      number: 15_072,
      mergeStatus: null,
      rollup: "pending",
      checks: [
        {
          name: "GitHub status",
          status: "in_progress",
          conclusion: null,
          url: "https://github.com/vm0-ai/vm0/pull/15072",
          startedAt: null,
          completedAt: null,
        },
      ],
    });
  });
});
