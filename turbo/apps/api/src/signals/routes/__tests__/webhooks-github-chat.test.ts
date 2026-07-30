import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  countGitHubRunsByPromptFixture,
  findGitHubInstallationIdFixture,
  findGitHubRunStateFixture,
  listGitHubChatRoutesFixture,
  readGitHubLegacySessionFixture,
  retryGitHubChatDeliveryFixture,
  signGitHubConnectParamsFixture,
  type GitHubRunStateFixture,
} from "../../../test-fixtures/github-chat";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi, newGithubUserId } from "./helpers/api-bdd-github";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

const context = testContext();
const bdd = createBddApi(context);
const github = createGithubBddApi(context);
const runs = createRunsApi(context);
const webhooks = createWebhookCallbackApi(context);
const REPO = "vm0-ai/vm0";

interface GitHubChatFixture {
  readonly actorA: ApiTestUser;
  readonly actorB: ApiTestUser;
  readonly agentId: string;
  readonly installationId: string;
  readonly remoteInstallationId: string;
  readonly githubUserA: string;
  readonly githubUserB: string;
  readonly runnerGroup: string;
  readonly postedComments: {
    readonly subjectNumber: number;
    readonly body: string;
  }[];
}

function configureGitHubApiMocks(): {
  readonly postedComments: {
    readonly subjectNumber: number;
    readonly body: string;
  }[];
} {
  const postedComments: {
    readonly subjectNumber: number;
    readonly body: string;
  }[] = [];
  let nextCommentId = 90_000;
  let nextReactionId = 80_000;

  server.use(
    http.get(
      `https://api.github.com/repos/${REPO}/issues/:subjectNumber/comments`,
      () => {
        return HttpResponse.json([]);
      },
    ),
    http.post(
      `https://api.github.com/repos/${REPO}/issues/comments/:commentId/reactions`,
      () => {
        return HttpResponse.json({ id: nextReactionId++ });
      },
    ),
    http.delete(
      `https://api.github.com/repos/${REPO}/issues/comments/:commentId/reactions/:reactionId`,
      () => {
        return new HttpResponse(null, { status: 204 });
      },
    ),
    http.post(
      `https://api.github.com/repos/${REPO}/issues/:subjectNumber/comments`,
      async ({ params, request }) => {
        const body = (await request.json()) as { readonly body: string };
        postedComments.push({
          subjectNumber: Number(params.subjectNumber),
          body: body.body,
        });
        return HttpResponse.json({ id: nextCommentId++ });
      },
    ),
  );
  return { postedComments };
}

async function connectSecondGitHubUser(args: {
  readonly actor: ApiTestUser;
  readonly remoteInstallationId: string;
  readonly githubUserId: string;
}): Promise<void> {
  const timestamp = Math.floor(now() / 1000);
  const githubUsername = "bdd-user-b";
  await github.connectUser(
    args.actor,
    {
      connectSignature: {
        installationId: args.remoteInstallationId,
        githubUserId: args.githubUserId,
        githubUsername,
        timestamp,
        signature: signGitHubConnectParamsFixture({
          installationId: args.remoteInstallationId,
          githubUserId: args.githubUserId,
          githubUsername,
          timestamp,
          secretsEncryptionKey: env("SECRETS_ENCRYPTION_KEY"),
        }),
      },
    },
    [200],
  );
}

async function seedFixture(): Promise<GitHubChatFixture> {
  const actorA = bdd.user();
  if (!actorA.orgId) {
    throw new Error("Expected org-scoped GitHub actor");
  }
  const actorB = bdd.user({
    orgId: actorA.orgId,
    orgRole: "org:member",
  });
  bdd.acceptAgentStorageWrites();
  await runs.grantProEntitlement(actorA);
  await runs.ensureOrgModelProvider(actorA);
  const agent = await bdd.createAgent(actorA, { visibility: "public" });
  const githubUserA = newGithubUserId();
  const githubUserB = newGithubUserId();
  const installed = await github.installGithubApp(actorA, agent.agentId, {
    oauthCode: {
      code: `github-chat-a-${randomUUID()}`,
      githubUserId: githubUserA,
      login: "bdd-user-a",
    },
  });
  await connectSecondGitHubUser({
    actor: actorB,
    remoteInstallationId: installed.remoteInstallationId,
    githubUserId: githubUserB,
  });

  webhooks.configureGithubWebhookSecret();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  const { postedComments } = configureGitHubApiMocks();
  return {
    actorA,
    actorB,
    agentId: agent.agentId,
    installationId: await findGitHubInstallationIdFixture(
      installed.remoteInstallationId,
    ),
    remoteInstallationId: installed.remoteInstallationId,
    githubUserA,
    githubUserB,
    runnerGroup,
    postedComments,
  };
}

function issueCommentPayload(args: {
  readonly fixture: GitHubChatFixture;
  readonly githubUserId: string;
  readonly commentId: number;
  readonly prompt: string;
  readonly subjectNumber: number;
  readonly subjectKind: "issue" | "pull_request";
}) {
  const sender = {
    id: Number(args.githubUserId),
    login:
      args.githubUserId === args.fixture.githubUserA
        ? "bdd-user-a"
        : "bdd-user-b",
    type: "User",
  };
  return {
    action: "created",
    issue: {
      number: args.subjectNumber,
      title: `Subject ${args.subjectNumber}`,
      body: "GitHub subject body",
      html_url: `https://github.com/${REPO}/${
        args.subjectKind === "pull_request" ? "pull" : "issues"
      }/${args.subjectNumber}`,
      labels: [],
      user: sender,
      ...(args.subjectKind === "pull_request" ? { pull_request: {} } : {}),
    },
    comment: {
      id: args.commentId,
      body: `@Zero ${args.prompt}`,
      html_url: `https://github.com/${REPO}/issues/${args.subjectNumber}#issuecomment-${args.commentId}`,
      user: sender,
    },
    repository: { id: 1, full_name: REPO },
    installation: { id: Number(args.fixture.remoteInstallationId) },
    sender,
  };
}

async function sendGitHubComment(args: {
  readonly fixture: GitHubChatFixture;
  readonly githubUserId: string;
  readonly commentId: number;
  readonly prompt: string;
  readonly subjectNumber: number;
  readonly subjectKind?: "issue" | "pull_request";
}): Promise<void> {
  const body = JSON.stringify(
    issueCommentPayload({
      ...args,
      subjectKind: args.subjectKind ?? "issue",
    }),
  );
  const response = await webhooks.requestGithubWebhook(
    body,
    webhooks.signedGithubWebhookHeaders(body, "issue_comment"),
    [200],
  );
  expect(response.body).toBe("OK");
  await flushWaitUntilForTest();
}

async function runState(
  userId: string,
  prompt: string,
): Promise<GitHubRunStateFixture> {
  return await findGitHubRunStateFixture(userId, prompt);
}

async function claimAndFinish(args: {
  readonly fixture: GitHubChatFixture;
  readonly run: GitHubRunStateFixture;
  readonly expectedResumeSessionId?: string;
  readonly exitCode?: number;
}): Promise<string> {
  await runs.heartbeatRunner(args.fixture.runnerGroup);
  const claim = await runs.claimRunnerJob(args.run.id);
  expect(claim.resumeSession?.sessionId).toBe(args.expectedResumeSessionId);

  const cliAgentSessionId = `bdd-github-cli-${args.run.id}`;
  const history = `bdd github history ${args.run.id}`;
  const hash = createHash("sha256").update(history).digest("hex");
  const size = Buffer.byteLength(history, "utf8");
  const headers = { authorization: `Bearer ${claim.sandboxToken}` };
  await webhooks.requestAgentCheckpointPrepareHistory(
    {
      runId: args.run.id,
      hash,
      rawSize: size,
      encodedSize: size,
      encoding: "identity",
    },
    headers,
    [200],
  );
  await webhooks.requestAgentCheckpoint(
    {
      runId: args.run.id,
      cliAgentType: "claude-code",
      cliAgentSessionId,
      cliAgentSessionHistoryHash: hash,
    },
    headers,
    [200],
  );
  await webhooks.requestAgentComplete(
    {
      runId: args.run.id,
      exitCode: args.exitCode ?? 0,
      ...(args.exitCode ? { error: "bdd GitHub run failure" } : {}),
    },
    headers,
    [200],
  );
  await flushWaitUntilForTest();
  return cliAgentSessionId;
}

async function routeRows(args: {
  readonly installationId: string;
  readonly subjectNumber: number;
}) {
  return await listGitHubChatRoutesFixture({ ...args, repo: REPO });
}

describe("GitHub canonical chat threads", () => {
  it("keeps A's session after B comments and deduplicates ingress and callback delivery", async () => {
    const fixture = await seedFixture();
    const subjectNumber = 23_919;
    let previousCliSession: string | undefined;
    let firstRun: GitHubRunStateFixture | undefined;

    for (let turn = 1; turn <= 3; turn++) {
      const prompt = `A turn ${turn}`;
      await sendGitHubComment({
        fixture,
        githubUserId: fixture.githubUserA,
        commentId: 10_000 + turn,
        prompt,
        subjectNumber,
      });
      const run = await runState(fixture.actorA.userId, prompt);
      firstRun ??= run;
      expect(run.chatThreadId).toBe(firstRun.chatThreadId);
      expect(run.sessionId).toBe(firstRun.sessionId);
      expect(run.triggerSource).toBe("github");
      previousCliSession = await claimAndFinish({
        fixture,
        run,
        expectedResumeSessionId: previousCliSession,
      });
    }

    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserB,
      commentId: 20_001,
      prompt: "B only turn",
      subjectNumber,
    });
    const bRun = await runState(fixture.actorB.userId, "B only turn");
    expect(bRun.chatThreadId).not.toBe(firstRun?.chatThreadId);
    expect(bRun.sessionId).not.toBe(firstRun?.sessionId);
    await claimAndFinish({ fixture, run: bRun });

    const legacyAfterB = await readGitHubLegacySessionFixture({
      installationId: fixture.installationId,
      repo: REPO,
      subjectNumber,
    });
    expect(legacyAfterB).toMatchObject({
      userId: fixture.actorB.userId,
      sessionId: bRun.sessionId,
    });

    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserA,
      commentId: 10_004,
      prompt: "A returns",
      subjectNumber,
    });
    const aReturn = await runState(fixture.actorA.userId, "A returns");
    expect(aReturn.chatThreadId).toBe(firstRun?.chatThreadId);
    expect(aReturn.sessionId).toBe(firstRun?.sessionId);
    expect(aReturn.sessionId).not.toBe(bRun.sessionId);
    const aReturnCliSession = await claimAndFinish({
      fixture,
      run: aReturn,
      expectedResumeSessionId: previousCliSession,
    });
    const legacyAfterAReturns = await readGitHubLegacySessionFixture({
      installationId: fixture.installationId,
      repo: REPO,
      subjectNumber,
    });
    expect(legacyAfterAReturns).toMatchObject({
      userId: fixture.actorA.userId,
      sessionId: aReturn.sessionId,
    });

    const routes = await routeRows({
      installationId: fixture.installationId,
      subjectNumber,
    });
    expect(routes).toHaveLength(2);
    expect(routes).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: fixture.actorA.userId,
          chatThreadId: firstRun?.chatThreadId,
          lastCommentId: "10004",
        }),
        expect.objectContaining({
          userId: fixture.actorB.userId,
          chatThreadId: bRun.chatThreadId,
          lastCommentId: "20001",
        }),
      ]),
    );

    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserA,
      commentId: 10_004,
      prompt: "A returns",
      subjectNumber,
    });
    await expect(
      countGitHubRunsByPromptFixture(fixture.actorA.userId, "A returns"),
    ).resolves.toBe(1);

    const deliveredCount = fixture.postedComments.length;
    await retryGitHubChatDeliveryFixture({
      runId: aReturn.id,
      status: "completed",
      signal: context.signal,
    });
    expect(fixture.postedComments).toHaveLength(deliveredCount);
    expect(fixture.postedComments).toHaveLength(5);
    expect(fixture.postedComments[0]).toMatchObject({
      subjectNumber,
      body: expect.stringContaining("> @Zero A turn 1"),
    });
    expect(firstRun?.appendSystemPrompt).toContain(
      `Issue URL: https://github.com/${REPO}/issues/${subjectNumber}`,
    );

    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserA,
      commentId: 10_005,
      prompt: "A fails after checkpoint",
      subjectNumber,
    });
    const failedRun = await runState(
      fixture.actorA.userId,
      "A fails after checkpoint",
    );
    expect(failedRun.sessionId).toBe(aReturn.sessionId);
    await claimAndFinish({
      fixture,
      run: failedRun,
      expectedResumeSessionId: aReturnCliSession,
      exitCode: 1,
    });
    const legacyAfterFailure = await readGitHubLegacySessionFixture({
      installationId: fixture.installationId,
      repo: REPO,
      subjectNumber,
    });
    expect(legacyAfterFailure).toMatchObject({
      userId: fixture.actorA.userId,
      sessionId: aReturn.sessionId,
      lastCommentId: legacyAfterAReturns?.lastCommentId,
    });
    expect(fixture.postedComments).toHaveLength(6);
  }, 30_000);

  it("routes pull request mentions through the same canonical table and preserves PR context", async () => {
    const fixture = await seedFixture();
    const subjectNumber = 24_001;
    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserA,
      commentId: 30_001,
      prompt: "review this pull request",
      subjectNumber,
      subjectKind: "pull_request",
    });
    const run = await runState(
      fixture.actorA.userId,
      "review this pull request",
    );
    expect(run.triggerSource).toBe("github");
    expect(run.appendSystemPrompt).toContain(
      `Pull Request URL: https://github.com/${REPO}/pull/${subjectNumber}`,
    );
    await sendGitHubComment({
      fixture,
      githubUserId: fixture.githubUserA,
      commentId: 30_002,
      prompt: "follow up in FIFO order",
      subjectNumber,
      subjectKind: "pull_request",
    });
    await expect(
      countGitHubRunsByPromptFixture(
        fixture.actorA.userId,
        "follow up in FIFO order",
      ),
    ).resolves.toBe(0);

    const firstCliSession = await claimAndFinish({ fixture, run });
    const followUp = await runState(
      fixture.actorA.userId,
      "follow up in FIFO order",
    );
    expect(followUp.chatThreadId).toBe(run.chatThreadId);
    expect(followUp.sessionId).toBe(run.sessionId);
    await claimAndFinish({
      fixture,
      run: followUp,
      expectedResumeSessionId: firstCliSession,
    });

    const routes = await routeRows({
      installationId: fixture.installationId,
      subjectNumber,
    });
    expect(routes).toStrictEqual([
      expect.objectContaining({
        userId: fixture.actorA.userId,
        chatThreadId: run.chatThreadId,
        lastCommentId: "30002",
      }),
    ]);
    expect(fixture.postedComments).toStrictEqual([
      expect.objectContaining({
        subjectNumber,
        body: expect.stringContaining("> @Zero review this pull request"),
      }),
      expect.objectContaining({
        subjectNumber,
        body: expect.stringContaining("> @Zero follow up in FIFO order"),
      }),
    ]);
  });
});
