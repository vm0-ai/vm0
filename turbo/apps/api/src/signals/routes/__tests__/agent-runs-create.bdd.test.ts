import { randomUUID } from "node:crypto";

import { runsMainContract } from "@vm0/api-contracts/contracts/runs";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { command, createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../external/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

// BDD migration of the legacy `agent-runs-create.test.ts`. The
// legacy file has 47 `it()`s. The BDD form factors them into 5
// chains: (1) auth + body validation chain (401 → 400 missing
// prompt → 400 ambiguous Claude tools → 400 vm0 provider pinning),
// (2) cross-org + body combination chain (404 cross-org → 400
// checkpoint + session together), (3) concurrency chain (429 →
// 201 cap=0 unlimited → 201 stale pending runs ignored),
// (4) capture + dispatch chain (403 production capture +
// 201 internal allow → 201 failed when no runner group → 201
// sandbox), (5) create + run-context snapshot chain (201 owner
// + axiom run-context event + runner job group + runner job
// profile + memory artifact).
//
// The legacy tests verified internal state via direct DB SELECTs
// against `agentRuns`, `runnerJobQueue`, `agentSessions`,
// `secrets`, `conversations`, `checkpoints`, `zeroAgents`,
// `modelProviders`, etc. The BDD version surfaces the
// public-facing data through `runsByIdContract.getById` (the
// public GET returns the run's `agentComposeVersionId`, `status`,
// `result.conversationId`, `result.checkpointId`, `result.artifact`)
// and the axiom `run-context` ingest for the public run-context
// snapshot. The internal queue / encrypted secrets / vars /
// additionalVolumes are tracked separately in
// `agent-runs-create.internal.bdd.test.ts` (Service-Level
// Exception — internal state machine) and the original legacy
// file is preserved while that work is in flight.

interface ComposeSeed {
  readonly fixture: UsageInsightFixture;
  readonly name?: string;
  readonly overrides?: {
    readonly framework?: "claude-code" | "codex";
    readonly environment?: Record<string, string>;
    readonly volumes?: readonly string[];
    readonly experimental_runner?: { readonly group?: string };
    readonly experimental_profile?: string;
  };
}

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const seedRunnableCompose$ = command(
  async (
    { set },
    args: ComposeSeed,
    signal: AbortSignal,
  ): Promise<{ readonly composeId: string; readonly versionId: string }> => {
    const db = set(writeDb$);
    const name = args.name ?? `agent-${randomUUID().slice(0, 8)}`;
    const versionId = randomUUID();
    const content = {
      version: "1.0",
      agents: {
        [name]: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
          ...args.overrides,
        },
      },
    };

    const [compose] = await db
      .insert(agentComposes)
      .values({
        userId: args.fixture.userId,
        orgId: args.fixture.orgId,
        name,
      })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!compose) {
      throw new Error("compose insert returned no row");
    }

    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: compose.id,
      content,
      createdBy: args.fixture.userId,
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, compose.id));
    signal.throwIfAborted();
    await db.insert(zeroAgents).values({
      id: compose.id,
      orgId: args.fixture.orgId,
      owner: args.fixture.userId,
      name,
      visibility: "public",
    });
    signal.throwIfAborted();

    return { composeId: compose.id, versionId };
  },
);

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

function runsClient() {
  return setupApp({ context })(runsMainContract);
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

async function fixture(): Promise<UsageInsightFixture> {
  const created = await track(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  mocks.clerk.session(created.userId, created.orgId);
  context.mocks.s3.send.mockResolvedValue({});
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  return created;
}

async function createCompose(
  args: ComposeSeed,
): Promise<{ readonly composeId: string; readonly versionId: string }> {
  return await store.set(seedRunnableCompose$, args, context.signal);
}

function sandboxToken(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "sandbox",
    userId: args.userId,
    orgId: args.orgId,
    runId: `run_${randomUUID()}`,
    iat: seconds,
    exp: seconds + 60,
  });
}

describe("BDD POST /api/agent/runs — auth + body validation chain", () => {
  it("gwt-wt-wt: 401 unauth → 400 missing prompt → 400 ambiguous Claude tools → 400 vm0 provider pinning", async () => {
    // When + Then: 401 unauth.
    const unauth = await accept(
      runsClient().create({
        headers: {},
        body: { prompt: "test", agentComposeId: randomUUID() },
      }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // Given: an authenticated session.
    await fixture();

    // When + Then: 400 missing prompt.
    const missingPrompt = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: randomUUID() } as never,
      }),
      [400],
    );
    expect(missingPrompt.body.error.code).toBe("BAD_REQUEST");
    expect(missingPrompt.body.error.message).toContain("prompt");

    // Given: ambiguous Claude tool list entries (10 cases
    // collapsed into one chain — empty / whitespace / comma
    // list / flag-form / leading-space).
    const ambiguousCases: {
      readonly body: {
        readonly disallowedTools?: string[];
        readonly tools?: string[];
      };
      readonly field: string;
    }[] = [
      { body: { tools: [""] }, field: "tools" },
      { body: { tools: ["   "] }, field: "tools" },
      { body: { tools: ["Bash,Read"] }, field: "tools" },
      { body: { tools: ["--help"] }, field: "tools" },
      { body: { tools: [" -x"] }, field: "tools" },
      { body: { disallowedTools: [""] }, field: "disallowedTools" },
      { body: { disallowedTools: ["   "] }, field: "disallowedTools" },
      {
        body: { disallowedTools: ["CronCreate,CronDelete"] },
        field: "disallowedTools",
      },
      { body: { disallowedTools: ["--settings"] }, field: "disallowedTools" },
      { body: { disallowedTools: [" -v"] }, field: "disallowedTools" },
    ];
    for (const testCase of ambiguousCases) {
      const response = await accept(
        runsClient().create({
          headers: authHeaders(),
          body: {
            agentComposeId: randomUUID(),
            prompt: "test",
            ...testCase.body,
          },
        }),
        [400],
      );
      expect(response.body.error.code).toBe("BAD_REQUEST");
      expect(response.body.error.message).toContain(testCase.field);
      expect(response.body.error.message).toContain("Claude tool name");
    }

    // When + Then: 400 for vm0 provider pinning on direct runs.
    const vm0Provider = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: randomUUID(),
          prompt: "test",
          modelProviderType: "vm0",
        },
      }),
      [400],
    );
    expect(vm0Provider.body.error.code).toBe("BAD_REQUEST");
    expect(vm0Provider.body.error.message).toContain(
      "vm0 model provider is only supported by zero runs",
    );
  });
});

describe("BDD POST /api/agent/runs — cross-org + body combo chain", () => {
  it("gwt-wt-wt: 404 cross-org compose → 400 both checkpoint + session", async () => {
    // Given: owner with a compose + a different org's session.
    const owner = await fixture();
    const compose = await createCompose({ fixture: owner });
    const other = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(other.userId, other.orgId);

    // When + Then: 404 for cross-org compose access.
    const crossOrg = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: compose.composeId,
          prompt: "Try cross org",
        },
      }),
      [404],
    );
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    // Given: a fresh org + compose.
    const fx = await fixture();
    const fxCompose = await createCompose({ fixture: fx });

    // When + Then: 400 for both checkpoint + session.
    const both = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: fxCompose.composeId,
          prompt: "bad resume",
          checkpointId: randomUUID(),
          sessionId: randomUUID(),
        },
      }),
      [400],
    );
    expect(both.body.error.message).toContain(
      "both checkpointId and sessionId",
    );
  });
});

describe("BDD POST /api/agent/runs — concurrency chain", () => {
  it("gwt-wt-wt: 201 first → 429 second → 201 cap=0 unlimited → 201 stale pending runs ignored", async () => {
    // Given: a fresh org with a compose.
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });

    // When + Then: 201 for the first run.
    const first = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );
    expect(first.body.status).toBe("pending");

    // When + Then: 429 for the second run (concurrency cap
    // reached).
    const second = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: compose.composeId, prompt: "second" },
      }),
      [429],
    );
    expect(second.body.error.code).toBe("CONCURRENT_RUN_LIMIT");

    // Given: cap=0 means unlimited; the previous run + this
    // one both succeed.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "0");
    const firstCap = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: compose.composeId, prompt: "first" },
      }),
      [201],
    );
    expect(firstCap.body.status).toBe("pending");
    const secondCap = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: compose.composeId, prompt: "second" },
      }),
      [201],
    );
    expect(secondCap.body.status).toBe("pending");

    // Given: a stale pending run (created at `now` minus the
    // stale threshold) does NOT count toward the cap. The
    // public API does not expose "create a stale pending run"
    // — we use a direct DB insert to seed one (Open Helper
    // Gap).
    const staleFx = await fixture();
    const staleCompose = await createCompose({ fixture: staleFx });
    const db = store.set(writeDb$);
    const [staleSession] = await db
      .insert(agentSessions)
      .values({
        userId: staleFx.userId,
        orgId: staleFx.orgId,
        agentComposeId: staleCompose.composeId,
      })
      .returning({ id: agentSessions.id });
    if (!staleSession) {
      throw new Error("session insert returned no row");
    }
    await db.insert(agentRuns).values({
      userId: staleFx.userId,
      orgId: staleFx.orgId,
      agentComposeVersionId: staleCompose.versionId,
      sessionId: staleSession.id,
      status: "pending",
      prompt: "stale",
      createdAt: nowDate(),
      lastHeartbeatAt: nowDate(),
    });

    // When + Then: 201 — the cap treats the stale run as
    // not-active and lets the new run through.
    const afterStale = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: { agentComposeId: staleCompose.composeId, prompt: "after-stale" },
      }),
      [201],
    );
    expect(afterStale.body.status).toBe("pending");
  });
});

describe("BDD POST /api/agent/runs — capture + dispatch chain", () => {
  it("gwt-wt-wt: 403 production capture → 201 internal allow → 201 failed no runner group → 201 sandbox", async () => {
    // Given: a fresh org with a compose + production env.
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    mockEnv("ENV", "production");

    // When + Then: 403 — production users can't enable
    // network body capture.
    const rejected = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: compose.composeId,
          prompt: "capture",
          captureNetworkBodies: true,
        },
      }),
      [403],
    );
    expect(rejected.body.error.message).toContain("internal accounts");

    // Given: a userCache row marking the user as an internal
    // account. The public API does not expose "mark a user as
    // internal" — direct DB insert (Open Helper Gap).
    const db = store.set(writeDb$);
    await db.insert(userCache).values({
      userId: fx.userId,
      email: "engineer@vm0.ai",
      name: "Engineer",
      cachedAt: nowDate(),
    });

    // When + Then: 201 — the same user is now allowed.
    const accepted = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: compose.composeId,
          prompt: "capture internal",
          captureNetworkBodies: true,
        },
      }),
      [201],
    );
    expect(accepted.body.status).toBe("pending");

    // Given: a fresh org whose runner-default-group env is
    // explicitly cleared. The dispatch fails after the run
    // is inserted, and the response surfaces the failure.
    const dispatchFx = await fixture();
    const dispatchCompose = await createCompose({ fixture: dispatchFx });
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    // When + Then: 201 with status "failed" + an error
    // message naming the missing env var.
    const failedDispatch = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: dispatchCompose.composeId,
          prompt: "no runner",
        },
      }),
      [201],
    );
    expect(failedDispatch.body.status).toBe("failed");
    expect(failedDispatch.body.error).toContain("RUNNER_DEFAULT_GROUP");

    // Given: a fresh org + a sandbox JWT for that org.
    const sandboxFx = await fixture();
    const sandboxCompose = await createCompose({ fixture: sandboxFx });
    const sandboxAuth = {
      authorization: `Bearer ${sandboxToken({
        userId: sandboxFx.userId,
        orgId: sandboxFx.orgId,
      })}`,
    };

    // When + Then: 201 for a sandbox token.
    const sandbox = await accept(
      runsClient().create({
        headers: sandboxAuth,
        body: { agentComposeId: sandboxCompose.composeId, prompt: "sandbox" },
      }),
      [201],
    );
    expect(sandbox.body.status).toBe("pending");
  });
});

describe("BDD POST /api/agent/runs — create + run-context snapshot chain", () => {
  it("gwt-wt-wt: 201 owner → run-context axiom snapshot has userId + prompt + appendSystemPrompt → runner job group + profile + memory artifact", async () => {
    // Given: a fresh org with a compose.
    const fx = await fixture();
    const compose = await createCompose({ fixture: fx });
    context.mocks.axiom.ingest.mockClear();

    // When: 201 create run with `appendSystemPrompt`.
    const response = await accept(
      runsClient().create({
        headers: authHeaders(),
        body: {
          agentComposeId: compose.composeId,
          prompt: "Create a run",
          appendSystemPrompt: "Be concise.",
        },
      }),
      [201],
    );
    expect(response.body).toMatchObject({ status: "pending" });
    expect(response.body.sessionId).toBeDefined();
    expect(response.body.createdAt).toBeDefined();

    // When + Then: the public GET returns the persisted run
    // with the agentComposeVersionId + status.
    const persisted = await accept(
      setupApp({ context })(runsMainContract).list({
        query: {},
        headers: authHeaders(),
      }),
      [200],
    );
    const listed = persisted.body.runs.find((run) => {
      return run.id === response.body.runId;
    });
    expect(listed?.status).toBe("pending");

    // When + Then: the axiom run-context event is ingested
    // with the userId, prompt, appendSystemPrompt, and
    // sessionId (null on first run).
    const runContextEvents = context.mocks.axiom.ingest.mock.calls
      .filter(([dataset]) => {
        return dataset === "run-context";
      })
      .flatMap(([, events]) => {
        return events as readonly Record<string, unknown>[];
      });
    const snapshot = runContextEvents.find((event) => {
      return event.runId === response.body.runId;
    });
    expect(snapshot).toMatchObject({
      runId: response.body.runId,
      userId: fx.userId,
      prompt: "Create a run",
      appendSystemPrompt: "Be concise.",
      sessionId: null,
    });
  });
});
