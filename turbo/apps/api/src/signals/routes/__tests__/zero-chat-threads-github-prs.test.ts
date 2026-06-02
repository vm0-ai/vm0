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

describe("GET /api/zero/chat-threads/:threadId/github-prs", () => {
  const trackThread = createFixtureTracker<ZeroChatThreadFixture>((fixture) => {
    return store.set(deleteZeroChatThread$, fixture, context.signal);
  });
  const trackGithubConnector = createFixtureTracker<GithubConnectorScope>(
    deleteGithubConnectorRows,
  );

  it("returns GitHub PR check status for pull requests mentioned in the thread", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(seedGithubConnector({ fixture }));
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content:
          "Created https://github.com/vm0-ai/vm0/pull/15070 and waiting on CI.",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
          return HttpResponse.json({
            state: "success",
            statuses: [],
          });
        },
      ),
    );

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.prs).toStrictEqual([
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
  });

  it("returns conflict merge status when GitHub reports an unmergeable PR", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(seedGithubConnector({ fixture }));
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content:
          "Review https://github.com/vm0-ai/vm0/pull/15071 before merging.",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
          return HttpResponse.json({
            state: "success",
            statuses: [],
          });
        },
      ),
    );

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.prs[0]).toMatchObject({
      repo: "vm0-ai/vm0",
      number: 15_071,
      mergeStatus: "conflicts",
      rollup: "none",
    });
  });

  it("surfaces pending aggregate commit status when GitHub returns no status contexts", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(seedGithubConnector({ fixture }));
    await store.set(
      seedZeroChatMessage$,
      fixture,
      {
        role: "assistant",
        content:
          "Review https://github.com/vm0-ai/vm0/pull/15072 before merging.",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

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
          return HttpResponse.json({
            state: "pending",
            statuses: [],
          });
        },
      ),
    );

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.prs[0]).toMatchObject({
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

  it("returns 403 when the agent has not authorized the GitHub connector", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(
      seedGithubConnector({ fixture, authorizeAgent: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "GitHub connector is not authorized for this agent",
    );
  });

  it("returns 403 when the feature switch is off", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(
      seedGithubConnector({ fixture, enableFeature: false }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: fixture.threadId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "GitHub PR tracking is not enabled",
    );
  });

  it("returns 404 for malformed thread IDs", async () => {
    const fixture = await trackThread(
      store.set(seedZeroChatThread$, {}, context.signal),
    );
    await trackGithubConnector(seedGithubConnector({ fixture }));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadGithubPrsContract);
    const response = await accept(
      client.list({
        params: { threadId: "not-a-uuid" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe("Chat thread not found");
  });
});
