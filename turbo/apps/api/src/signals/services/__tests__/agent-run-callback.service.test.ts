import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { automations, automationTriggers } from "@vm0/db/schema/automation";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { testContext } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "../../routes/__tests__/helpers/agent-run-callback";
import {
  captureGithubIssueApi,
  mockGithubAppEnv,
} from "../../routes/__tests__/helpers/api-bdd-github";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "../../routes/__tests__/helpers/zero-integrations-slack";
import { createFixtureTracker } from "../../routes/__tests__/helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "../../routes/__tests__/helpers/zero-usage-insight";
import {
  dispatchRunCallbacks,
  dispatchRunCallbacks$,
} from "../agent-run-callback.service";
import { dispatchProgressCallbacks$ } from "../agent-run-callbacks.service";
import { createZeroRun$ } from "../zero-runs-create.service";

const context = testContext();
const store = createStore();

const AGENT_CALLBACK_URL = "http://localhost:3000/api/internal/callbacks/agent";
const TRIGGER_CRON_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/trigger/cron";
const TRIGGER_LOOP_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/trigger/loop";
const GITHUB_ISSUES_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/github/issues";
const SLACK_ORG_CALLBACK_URL =
  "http://localhost:3000/api/internal/callbacks/slack/org";
const OPENROUTER_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

interface AgentCallbackRunFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly runId: string;
}

interface Vm0ProviderKeyFixture {
  readonly label: string;
}

interface OpenRouterRequest {
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
  }[];
}

const trackSlackIntegration = createFixtureTracker<SlackIntegrationFixture>(
  (fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  },
);

const trackFixture = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

const trackVm0ProviderKey = createFixtureTracker<Vm0ProviderKeyFixture>(
  async (fixture) => {
    const db = store.set(writeDb$);
    await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.label));
  },
);

async function seedAgentCallbackRun(
  options: {
    readonly status?: "pending" | "running" | "completed" | "failed";
  } = {},
): Promise<AgentCallbackRunFixture> {
  const fixture = await trackFixture(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const { composeId } = await store.set(
    seedCompose$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      triggerSource: "agent",
      status: options.status ?? "completed",
      prompt: "Summarize the delegated task.",
      lastEventSequence: 0,
    },
    context.signal,
  );
  return { ...fixture, composeId, runId };
}

function mockRunOutput(result: string): void {
  context.mocks.axiom.query.mockImplementation((...args: unknown[]) => {
    const apl = typeof args[0] === "string" ? args[0] : "";
    return Promise.resolve(
      apl.includes("agent-run-events")
        ? [{ eventType: "result", eventData: { result } }]
        : [],
    );
  });
}

function captureOpenRouterRequests(summary: string): OpenRouterRequest[] {
  const requests: OpenRouterRequest[] = [];
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post(OPENROUTER_COMPLETIONS_URL, async ({ request }) => {
      requests.push((await request.json()) as OpenRouterRequest);
      return HttpResponse.json({
        choices: [{ message: { content: summary } }],
      });
    }),
  );
  return requests;
}

function failIfAgentCallbackRouteIsFetched(): () => number {
  let requests = 0;
  server.use(
    http.post(AGENT_CALLBACK_URL, () => {
      requests += 1;
      return HttpResponse.text("agent callback route should not be fetched", {
        status: 500,
      });
    }),
  );
  return () => {
    return requests;
  };
}

function failIfCallbackRouteIsFetched(url: string): () => number {
  let requests = 0;
  server.use(
    http.post(url, () => {
      requests += 1;
      return HttpResponse.text(
        "internal callback route should not be fetched",
        {
          status: 500,
        },
      );
    }),
  );
  return () => {
    return requests;
  };
}

async function readCallback(callbackId: string) {
  const db = store.set(writeDb$);
  const [callback] = await db
    .select({
      url: agentRunCallbacks.url,
      internalKind: agentRunCallbacks.internalKind,
      status: agentRunCallbacks.status,
      attempts: agentRunCallbacks.attempts,
      deliveredAt: agentRunCallbacks.deliveredAt,
      lastError: agentRunCallbacks.lastError,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.id, callbackId))
    .limit(1);
  return callback;
}

async function readSummary(runId: string): Promise<string | null | undefined> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ summary: zeroRuns.summary })
    .from(zeroRuns)
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  return row?.summary;
}

async function readTrigger(triggerId: string) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select()
    .from(automationTriggers)
    .where(eq(automationTriggers.id, triggerId))
    .limit(1);
  return row;
}

async function readGithubIssueSession(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly issueNumber: number;
}) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select()
    .from(githubIssueSessions)
    .where(
      and(
        eq(githubIssueSessions.installationId, args.installationId),
        eq(githubIssueSessions.repo, args.repo),
        eq(githubIssueSessions.issueNumber, args.issueNumber),
      ),
    )
    .limit(1);
  return row;
}

async function readSlackConnectionId(args: {
  readonly workspaceId: string;
  readonly slackUserId: string;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackWorkspaceId, args.workspaceId),
        eq(slackOrgConnections.slackUserId, args.slackUserId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Expected Slack org connection");
  }
  return row.id;
}

async function readSlackThreadSession(args: {
  readonly connectionId: string;
  readonly channelId: string;
  readonly threadTs: string;
}) {
  const db = store.set(writeDb$);
  const [row] = await db
    .select()
    .from(slackOrgThreadSessions)
    .where(
      and(
        eq(slackOrgThreadSessions.connectionId, args.connectionId),
        eq(slackOrgThreadSessions.slackChannelId, args.channelId),
        eq(slackOrgThreadSessions.slackThreadTs, args.threadTs),
      ),
    )
    .limit(1);
  return row;
}

async function seedSlackCallbackContext(
  fixture: AgentCallbackRunFixture,
): Promise<{
  readonly workspaceId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly connectionId: string;
  readonly agentId: string;
}> {
  const workspaceId = `T${fixture.runId.replace(/\W/gu, "").slice(0, 10)}`;
  await trackSlackIntegration(
    store.set(
      seedSlackOrgInstallation$,
      {
        orgId: fixture.orgId,
        slackWorkspaceId: workspaceId,
        botToken: `xoxb-${fixture.runId}`,
      },
      context.signal,
    ),
  );
  const slackUserId = `U${fixture.runId.replace(/\W/gu, "").slice(0, 10)}`;
  await store.set(
    seedSlackOrgConnection$,
    {
      slackWorkspaceId: workspaceId,
      vm0UserId: fixture.userId,
      slackUserId,
    },
    context.signal,
  );
  const connectionId = await readSlackConnectionId({
    workspaceId,
    slackUserId,
  });
  return {
    workspaceId,
    channelId: `C${fixture.runId.replace(/\W/gu, "").slice(0, 10)}`,
    threadTs: "1710000000.000100",
    messageTs: "1710000000.000100",
    connectionId,
    agentId: fixture.composeId,
  };
}

function mockSlackApi(): void {
  context.mocks.slack.chat.postMessage.mockResolvedValue({
    ok: true,
    ts: "1710000000.000200",
    channel: "C_CALLBACK",
  });
  context.mocks.slack.assistant.threads.setStatus.mockResolvedValue({
    ok: true,
  });
}

async function seedGithubInstallation(
  fixture: AgentCallbackRunFixture,
): Promise<{
  readonly installationId: string;
  readonly remoteInstallationId: string;
}> {
  const db = store.set(writeDb$);
  const numericRunId = fixture.runId.replace(/\D/gu, "").padEnd(9, "0");
  const remoteInstallationId = `9${numericRunId.slice(0, 9)}`;
  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId: remoteInstallationId,
      status: "active",
      orgId: fixture.orgId,
      defaultComposeId: fixture.composeId,
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Failed to seed GitHub installation");
  }
  return { installationId: installation.id, remoteInstallationId };
}

async function seedGithubAgentSession(
  fixture: AgentCallbackRunFixture,
): Promise<string> {
  const db = store.set(writeDb$);
  const [session] = await db
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed GitHub agent session");
  }
  return session.id;
}

async function seedAutomationTrigger(
  fixture: AgentCallbackRunFixture,
  options: {
    readonly kind: "cron" | "loop";
    readonly consecutiveFailures?: number;
    readonly intervalSeconds?: number;
    readonly cronExpression?: string;
  },
): Promise<string> {
  const db = store.set(writeDb$);
  const [thread] = await db
    .insert(chatThreads)
    .values({ userId: fixture.userId, agentComposeId: fixture.composeId })
    .returning({ id: chatThreads.id });
  if (!thread) {
    throw new Error("Failed to seed trigger chat thread");
  }
  const [automation] = await db
    .insert(automations)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: `callback-test-${fixture.runId.slice(0, 8)}`,
      instruction: "Run a scheduled task",
      agentId: fixture.composeId,
      chatThreadId: thread.id,
      interpreterKind: "time",
    })
    .returning({ id: automations.id });
  if (!automation) {
    throw new Error("Failed to seed automation");
  }
  const isCron = options.kind === "cron";
  const [trigger] = await db
    .insert(automationTriggers)
    .values({
      automationId: automation.id,
      kind: options.kind,
      cronExpression: isCron ? (options.cronExpression ?? "0 9 * * *") : null,
      intervalSeconds: isCron ? null : (options.intervalSeconds ?? 300),
      timezone: "UTC",
      nextRunAt: null,
      enabled: true,
      consecutiveFailures: options.consecutiveFailures ?? 0,
    })
    .returning({ id: automationTriggers.id });
  if (!trigger) {
    throw new Error("Failed to seed automation trigger");
  }
  return trigger.id;
}

async function seedVm0ProviderKey(
  label: string,
): Promise<Vm0ProviderKeyFixture> {
  const db = store.set(writeDb$);
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, label));
  await db.insert(vm0ApiKeys).values({
    vendor: "anthropic",
    model: "claude-sonnet-4-6",
    apiKey: `vm0-key-agent-callback-${label}`,
    label,
  });
  return { label };
}

afterEach(() => {
  clearMockNow();
});

describe("dispatchRunCallbacks$ agent internal dispatch", () => {
  it("dispatches typed agent callbacks through ccstate without fetching the route", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "agent",
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    mockRunOutput("Typed callback finished.");
    const openRouterRequests = captureOpenRouterRequests("Typed agent summary");
    const routeRequests = failIfAgentCallbackRouteIsFetched();
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(openRouterRequests).toHaveLength(1);
    expect(openRouterRequests[0]?.messages[1]?.content).toContain(
      "Typed callback finished.",
    );
    await expect(readSummary(fixture.runId)).resolves.toBe(
      "Typed agent summary",
    );
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "agent",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
    expect((await readCallback(callbackId))?.deliveredAt).toBeInstanceOf(Date);
  });

  it("dispatches legacy agent callback URLs through the same ccstate path", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: AGENT_CALLBACK_URL,
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    mockRunOutput("Legacy callback finished.");
    const openRouterRequests = captureOpenRouterRequests(
      "Legacy agent summary",
    );
    const routeRequests = failIfAgentCallbackRouteIsFetched();
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(openRouterRequests).toHaveLength(1);
    expect(openRouterRequests[0]?.messages[1]?.content).toContain(
      "Legacy callback finished.",
    );
    await expect(readSummary(fixture.runId)).resolves.toBe(
      "Legacy agent summary",
    );
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: AGENT_CALLBACK_URL,
      internalKind: null,
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("keeps non-completed agent callbacks as no-ops", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "agent",
        payload: { triggerAgentId: fixture.composeId },
      },
      context.signal,
    );
    context.mocks.axiom.query.mockImplementation(() => {
      throw new Error("failed agent callbacks should not query output");
    });
    const openRouterRequests = captureOpenRouterRequests("Unexpected summary");
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: fixture.runId,
        status: "failed",
        error: "Run failed",
      },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
    expect(openRouterRequests).toHaveLength(0);
    await expect(readSummary(fixture.runId)).resolves.toBeNull();
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("creates trigger-agent callback rows with typed internal identity", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    const fixture = await trackFixture(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId, agentId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: parentRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        triggerSource: "web",
        status: "running",
      },
      context.signal,
    );
    await trackVm0ProviderKey(seedVm0ProviderKey(composeId));
    const db = store.set(writeDb$);

    const response = await store.set(
      createZeroRun$,
      {
        auth: {
          tokenType: "sandbox",
          userId: fixture.userId,
          orgId: fixture.orgId,
          runId: parentRunId,
        },
        body: {
          agentId,
          modelProvider: "vm0",
          prompt: "Delegate this task.",
        },
        apiStartTime: now(),
      },
      context.signal,
    );

    if (response.status !== 201) {
      throw new Error(
        `Expected createZeroRun$ to create a run, received ${JSON.stringify(
          response.body,
        )}`,
      );
    }
    const callbacks = await db
      .select({
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, response.body.runId));

    expect(callbacks).toStrictEqual([
      {
        url: null,
        internalKind: "agent",
        payload: { triggerAgentId: composeId },
      },
    ]);
  });
});

describe("dispatchRunCallbacks$ GitHub issues internal dispatch", () => {
  it("dispatches typed GitHub issue callbacks through ccstate without fetching the route", async () => {
    mockGithubAppEnv();
    const fixture = await seedAgentCallbackRun();
    const installation = await seedGithubInstallation(fixture);
    const newSessionId = await seedGithubAgentSession(fixture);
    const issueApi = captureGithubIssueApi(installation.remoteInstallationId);
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "github:issues",
        payload: {
          installationId: installation.installationId,
          repo: "vm0-ai/vm0",
          issueNumber: 42,
          agentId: fixture.composeId,
          triggerCommentId: "1234",
          triggerReactionId: "5678",
          triggerCommentBody: "@Zero fix this",
        },
      },
      context.signal,
    );
    mockRunOutput("GitHub callback finished.");
    const routeRequests = failIfCallbackRouteIsFetched(
      GITHUB_ISSUES_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(issueApi.comments).toHaveLength(1);
    expect(issueApi.comments[0]).toMatchObject({
      repo: "vm0-ai/vm0",
      issueNumber: "42",
    });
    expect(issueApi.comments[0]?.body).toContain("> @Zero fix this");
    expect(issueApi.comments[0]?.body).toContain("GitHub callback finished.");
    expect(issueApi.reactionDeletes).toStrictEqual([
      { commentId: "1234", reactionId: "5678" },
    ]);
    await expect(
      readGithubIssueSession({
        installationId: installation.installationId,
        repo: "vm0-ai/vm0",
        issueNumber: 42,
      }),
    ).resolves.toMatchObject({
      agentSessionId: newSessionId,
      lastCommentId: issueApi.comments[0]?.id,
    });
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "github:issues",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("dispatches legacy GitHub issue callback URLs through the same ccstate path", async () => {
    mockGithubAppEnv();
    const fixture = await seedAgentCallbackRun();
    const installation = await seedGithubInstallation(fixture);
    const issueApi = captureGithubIssueApi(installation.remoteInstallationId);
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: GITHUB_ISSUES_CALLBACK_URL,
        payload: {
          installationId: installation.installationId,
          repo: "vm0-ai/vm0",
          issueNumber: 43,
          agentId: fixture.composeId,
        },
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      GITHUB_ISSUES_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: fixture.runId,
        status: "failed",
        error: "Legacy GitHub failure",
      },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(issueApi.comments).toHaveLength(1);
    expect(issueApi.comments[0]).toMatchObject({
      repo: "vm0-ai/vm0",
      issueNumber: "43",
    });
    expect(issueApi.comments[0]?.body).toContain("Oops, something went wrong.");
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: GITHUB_ISSUES_CALLBACK_URL,
      internalKind: null,
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("marks invalid typed GitHub issue callback payloads as failed", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "github:issues",
        payload: {},
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      GITHUB_ISSUES_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([
      {
        callbackId,
        success: false,
        error: "Invalid or missing payload",
      },
    ]);
    expect(routeRequests()).toBe(0);
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Invalid or missing payload",
    });
  });

  it("dispatches typed GitHub issue callbacks from the non-ccstate wrapper", async () => {
    mockGithubAppEnv();
    const fixture = await seedAgentCallbackRun();
    const installation = await seedGithubInstallation(fixture);
    const issueApi = captureGithubIssueApi(installation.remoteInstallationId);
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "github:issues",
        payload: {
          installationId: installation.installationId,
          repo: "vm0-ai/vm0",
          issueNumber: 44,
          agentId: fixture.composeId,
          sessionContinuityEnabled: false,
        },
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      GITHUB_ISSUES_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await dispatchRunCallbacks(
      db,
      fixture.runId,
      "failed",
      undefined,
      "Non-ccstate GitHub failure",
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(issueApi.comments).toHaveLength(1);
    expect(issueApi.comments[0]?.body).toContain("Oops, something went wrong.");
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });
});

describe("dispatchRunCallbacks$ Slack org internal dispatch", () => {
  it("dispatches typed Slack org callbacks through ccstate without fetching the route", async () => {
    const fixture = await seedAgentCallbackRun();
    const payload = await seedSlackCallbackContext(fixture);
    mockSlackApi();
    mockRunOutput("Slack callback finished.");
    const openRouterRequests = captureOpenRouterRequests("Slack run summary");
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "slack:org",
        payload,
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(SLACK_ORG_CALLBACK_URL);
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );
    await flushWaitUntilForTest();

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: payload.channelId,
        thread_ts: payload.threadTs,
        text: "Slack callback finished.",
      }),
    );
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenLastCalledWith({
      channel_id: payload.channelId,
      thread_ts: payload.threadTs,
      status: "",
    });
    expect(openRouterRequests).toHaveLength(1);
    await expect(readSummary(fixture.runId)).resolves.toBe("Slack run summary");
    await expect(
      readSlackThreadSession({
        connectionId: payload.connectionId,
        channelId: payload.channelId,
        threadTs: payload.threadTs,
      }),
    ).resolves.toMatchObject({
      agentSessionId: expect.any(String),
    });
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "slack:org",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("dispatches typed Slack org progress callbacks without fetching the route", async () => {
    const fixture = await seedAgentCallbackRun({ status: "running" });
    const payload = await seedSlackCallbackContext(fixture);
    mockSlackApi();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "slack:org",
        payload,
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(SLACK_ORG_CALLBACK_URL);

    await store.set(dispatchProgressCallbacks$, fixture.runId, context.signal);
    await flushWaitUntilForTest();

    expect(routeRequests()).toBe(0);
    expect(
      context.mocks.slack.assistant.threads.setStatus,
    ).toHaveBeenCalledWith({
      channel_id: payload.channelId,
      thread_ts: payload.threadTs,
      status: "is thinking...",
    });
    expect(context.mocks.slack.chat.postMessage).not.toHaveBeenCalled();
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "slack:org",
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("dispatches legacy Slack org callback URLs through the same ccstate path", async () => {
    const fixture = await seedAgentCallbackRun();
    const payload = await seedSlackCallbackContext(fixture);
    mockSlackApi();
    context.mocks.slack.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("channel_not_found"), {
        data: { ok: false, error: "channel_not_found" },
      }),
    );
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: SLACK_ORG_CALLBACK_URL,
        payload,
      },
      context.signal,
    );
    mockRunOutput("Undelivered Slack output.");
    const routeRequests = failIfCallbackRouteIsFetched(SLACK_ORG_CALLBACK_URL);
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([
      {
        callbackId,
        success: false,
        error: "Slack API error: channel_not_found",
      },
    ]);
    expect(routeRequests()).toBe(0);
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: SLACK_ORG_CALLBACK_URL,
      internalKind: null,
      status: "failed",
      attempts: 1,
      lastError: "Slack API error: channel_not_found",
    });
  });

  it("dispatches typed Slack org callbacks from the non-ccstate wrapper", async () => {
    const fixture = await seedAgentCallbackRun();
    const payload = await seedSlackCallbackContext(fixture);
    mockSlackApi();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "slack:org",
        payload,
      },
      context.signal,
    );
    mockRunOutput("Non-ccstate Slack output.");
    const routeRequests = failIfCallbackRouteIsFetched(SLACK_ORG_CALLBACK_URL);
    const db = store.set(writeDb$);

    const results = await dispatchRunCallbacks(db, fixture.runId, "completed");
    await flushWaitUntilForTest();

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    expect(context.mocks.slack.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: payload.channelId,
        thread_ts: payload.threadTs,
        text: "Non-ccstate Slack output.",
      }),
    );
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });
});

describe("dispatchRunCallbacks$ trigger internal dispatch", () => {
  it("dispatches typed loop trigger callbacks through ccstate without fetching the route", async () => {
    mockNow(new Date("2026-05-13T04:00:00.000Z"));
    const fixture = await seedAgentCallbackRun();
    const triggerId = await seedAutomationTrigger(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
      intervalSeconds: 300,
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "trigger:loop",
        payload: { triggerId },
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      TRIGGER_LOOP_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    await expect(readTrigger(triggerId)).resolves.toMatchObject({
      consecutiveFailures: 0,
      enabled: true,
      nextRunAt: new Date("2026-05-13T04:05:00.000Z"),
    });
    await expect(readSummary(fixture.runId)).resolves.toBeNull();
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: null,
      internalKind: "trigger:loop",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("dispatches legacy cron trigger URLs through the same ccstate path", async () => {
    const fixture = await seedAgentCallbackRun();
    const triggerId = await seedAutomationTrigger(fixture, {
      kind: "cron",
      consecutiveFailures: 2,
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        url: TRIGGER_CRON_CALLBACK_URL,
        payload: { triggerId, cronExpression: "0 9 * * *", timezone: "UTC" },
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      TRIGGER_CRON_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      {
        db,
        runId: fixture.runId,
        status: "failed",
        error: "Agent crashed",
      },
      context.signal,
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    await expect(readTrigger(triggerId)).resolves.toMatchObject({
      consecutiveFailures: 3,
      enabled: false,
      nextRunAt: null,
    });
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      url: TRIGGER_CRON_CALLBACK_URL,
      internalKind: null,
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });

  it("marks invalid typed trigger callback payloads as failed", async () => {
    const fixture = await seedAgentCallbackRun();
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "trigger:loop",
        payload: {},
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      TRIGGER_LOOP_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await store.set(
      dispatchRunCallbacks$,
      { db, runId: fixture.runId, status: "completed" },
      context.signal,
    );

    expect(results).toStrictEqual([
      {
        callbackId,
        success: false,
        error: "Invalid or missing payload",
      },
    ]);
    expect(routeRequests()).toBe(0);
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "Invalid or missing payload",
    });
  });

  it("dispatches typed trigger callbacks from the non-ccstate wrapper", async () => {
    const fixture = await seedAgentCallbackRun();
    const triggerId = await seedAutomationTrigger(fixture, {
      kind: "loop",
      consecutiveFailures: 2,
    });
    const { callbackId } = await store.set(
      seedAgentRunCallback$,
      {
        runId: fixture.runId,
        internalKind: "trigger:loop",
        payload: { triggerId },
      },
      context.signal,
    );
    const routeRequests = failIfCallbackRouteIsFetched(
      TRIGGER_LOOP_CALLBACK_URL,
    );
    const db = store.set(writeDb$);

    const results = await dispatchRunCallbacks(
      db,
      fixture.runId,
      "failed",
      undefined,
      "Run failed",
    );

    expect(results).toStrictEqual([{ callbackId, success: true }]);
    expect(routeRequests()).toBe(0);
    await expect(readTrigger(triggerId)).resolves.toMatchObject({
      consecutiveFailures: 3,
      enabled: false,
      nextRunAt: null,
    });
    await expect(readCallback(callbackId)).resolves.toMatchObject({
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
  });
});
