import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { computeHmacSignature } from "../../../lib/event-consumer/hmac";
import { mockOptionalEnv } from "../../../lib/env";
import { now, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { seedAgentRunCallback$ } from "./helpers/agent-run-callback";
import { createFixtureTracker } from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();

const PATH = "/api/internal/callbacks/github/issues";
const TEST_CALLBACK_SECRET = "test-callback-secret";
const GITHUB_APP_ID = "123456";
const GITHUB_COMMENT_ID = "42";

interface GitHubIssuesFixture extends UsageInsightFixture {
  readonly composeId: string;
}

interface GitHubIssuesPayload {
  readonly installationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly agentId: string;
  readonly existingSessionId?: string;
  readonly triggerCommentId?: string;
  readonly triggerReactionId?: string;
  readonly triggerCommentBody?: string;
}

interface CapturedComment {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: string;
  readonly body: string;
}

interface CapturedReactionDelete {
  readonly commentId: string;
  readonly reactionId: string;
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function remoteInstallationId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function mockGithubAppEnv(): void {
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
}

function setupGithubApiMocks(installationId: string): {
  readonly capturedComments: CapturedComment[];
  readonly capturedReactionDeletes: CapturedReactionDelete[];
} {
  const capturedComments: CapturedComment[] = [];
  const capturedReactionDeletes: CapturedReactionDelete[] = [];

  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      async ({ params, request }) => {
        const body = (await request.json()) as { readonly body: string };
        capturedComments.push({
          owner: String(params["owner"]),
          repo: String(params["repo"]),
          issueNumber: String(params["issueNumber"]),
          body: body.body,
        });
        return HttpResponse.json({ id: Number(GITHUB_COMMENT_ID) });
      },
    ),
    http.delete(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions/:reactionId",
      ({ params }) => {
        capturedReactionDeletes.push({
          commentId: String(params["commentId"]),
          reactionId: String(params["reactionId"]),
        });
        return HttpResponse.json({});
      },
    ),
  );

  return { capturedComments, capturedReactionDeletes };
}

async function deleteFixture(fixture: GitHubIssuesFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb
    .delete(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, fixture.orgId),
        eq(userFeatureSwitches.userId, fixture.userId),
      ),
    );
  await store.set(deleteUsageInsightFixture$, fixture, context.signal);
}

async function seedFixture(): Promise<GitHubIssuesFixture> {
  const base = await store.set(
    seedUsageInsightFixture$,
    undefined,
    context.signal,
  );
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId: base.orgId,
      userId: base.userId,
      name: `github-issues-callback-${randomUUID().slice(0, 8)}`,
      displayName: "GitHub Agent",
    },
    context.signal,
  );
  return { ...base, composeId };
}

async function seedGithubInstallation(args: {
  readonly composeId: string;
  readonly installationId?: string | null;
  readonly status?: "active" | "pending";
}): Promise<{
  readonly id: string;
  readonly installationId: string | null;
}> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .insert(githubInstallations)
    .values({
      defaultComposeId: args.composeId,
      installationId:
        args.installationId === undefined
          ? remoteInstallationId()
          : args.installationId,
      status: args.status ?? "active",
    })
    .returning({
      id: githubInstallations.id,
      installationId: githubInstallations.installationId,
    });

  if (!row) {
    throw new Error("seedGithubInstallation: insert returned no row");
  }
  return row;
}

async function seedRunAndCallback(args: {
  readonly fixture: GitHubIssuesFixture;
  readonly payload: GitHubIssuesPayload;
}): Promise<{ readonly runId: string; readonly callbackId: string }> {
  const createdAt = new Date(now() - 60_000);
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      composeId: args.fixture.composeId,
      triggerSource: "github",
      prompt: "Handle GitHub issue",
      createdAt,
      lastEventSequence: 0,
    },
    context.signal,
  );
  const { callbackId } = await store.set(
    seedAgentRunCallback$,
    {
      runId,
      url: `http://localhost${PATH}`,
      payload: args.payload as unknown as Record<string, unknown>,
    },
    context.signal,
  );
  return { runId, callbackId };
}

async function seedAgentSession(
  fixture: GitHubIssuesFixture,
): Promise<{ readonly id: string }> {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
    .insert(agentSessions)
    .values({
      userId: fixture.userId,
      orgId: fixture.orgId,
      agentComposeId: fixture.composeId,
      updatedAt: nowDate(),
    })
    .returning({ id: agentSessions.id });
  if (!row) {
    throw new Error("seedAgentSession: insert returned no row");
  }
  return row;
}

async function seedIssueSession(args: {
  readonly userId: string;
  readonly installationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly agentSessionId: string;
  readonly lastCommentId: string;
}): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(githubIssueSessions).values(args);
}

async function findIssueSession(args: {
  readonly installationId: string;
  readonly repo: string;
  readonly issueNumber: number;
}) {
  const writeDb = store.set(writeDb$);
  const [row] = await writeDb
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
  return row ?? null;
}

async function enableAuditLink(fixture: GitHubIssuesFixture): Promise<void> {
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.AuditLink]: true },
  });
}

function signedHeaders(
  rawBody: string,
  secret = TEST_CALLBACK_SECRET,
  timestamp = Math.floor(now() / 1000),
) {
  return {
    "Content-Type": "application/json",
    "X-VM0-Signature": computeHmacSignature(rawBody, secret, timestamp),
    "X-VM0-Timestamp": String(timestamp),
  };
}

async function postSignedCallback(
  body: Record<string, unknown>,
  secret?: string,
  timestamp?: number,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const app = createApp({ signal: context.signal });
  return await app.request(PATH, {
    method: "POST",
    headers: signedHeaders(rawBody, secret, timestamp),
    body: rawBody,
  });
}

function completedOutput(): void {
  context.mocks.axiom.query.mockResolvedValueOnce([
    {
      eventType: "result",
      eventData: { result: "Implemented the requested issue fix." },
    },
  ]);
}

afterEach(() => {
  context.mocks.axiom.query.mockReset();
});

describe("POST /api/internal/callbacks/github/issues", () => {
  const track = createFixtureTracker<GitHubIssuesFixture>((fixture) => {
    return deleteFixture(fixture);
  });

  it("rejects callback bodies missing runId", async () => {
    const response = await postSignedCallback({
      status: "completed",
      payload: {
        installationId: "00000000-0000-0000-0000-000000000001",
        repo: "test-org/test-repo",
        issueNumber: 42,
        agentId: "00000000-0000-0000-0000-000000000002",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing runId",
    });
  });

  it("rejects requests with invalid signatures", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback(
      { callbackId, runId, status: "completed", payload },
      "wrong-secret",
    );

    expect(response.status).toBe(401);
  });

  it("rejects requests with expired timestamps", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    const expiredTimestamp = Math.floor((now() - 10 * 60_000) / 1000);

    const response = await postSignedCallback(
      { callbackId, runId, status: "completed", payload },
      TEST_CALLBACK_SECRET,
      expiredTimestamp,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Timestamp expired",
    });
  });

  it("returns 404 when no callback record exists", async () => {
    const response = await postSignedCallback({
      runId: "00000000-0000-0000-0000-000000000000",
      status: "completed",
      payload: {
        installationId: "00000000-0000-0000-0000-000000000001",
        repo: "test-org/test-repo",
        issueNumber: 42,
        agentId: "00000000-0000-0000-0000-000000000002",
      },
    });

    expect(response.status).toBe(404);
  });

  it("rejects invalid payloads after callback verification", async () => {
    const fixture = await track(seedFixture());
    const payload: GitHubIssuesPayload = {
      installationId: "00000000-0000-0000-0000-000000000001",
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload: { installationId: payload.installationId },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Invalid or missing payload",
    });
  });

  it("returns success without side effects for progress callbacks", async () => {
    const fixture = await track(seedFixture());
    const payload: GitHubIssuesPayload = {
      installationId: "00000000-0000-0000-0000-000000000001",
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "progress",
      payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("returns 404 when the GitHub installation is missing", async () => {
    const fixture = await track(seedFixture());
    const payload: GitHubIssuesPayload = {
      installationId: "00000000-0000-0000-0000-000000000099",
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: "GitHub installation not found",
    });
  });

  it("returns 400 when the GitHub installation is pending", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
      installationId: null,
      status: "pending",
    });
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "GitHub installation is pending approval",
    });
  });

  it("returns 500 when GitHub App credentials are not configured", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "GitHub App not configured",
    });
  });

  it("posts a completed run comment without an audit link when the switch is off", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    const { capturedComments } = setupGithubApiMocks(
      installation.installationId,
    );
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    completedOutput();

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ success: true });
    expect(capturedComments).toHaveLength(1);
    expect(capturedComments[0]).toMatchObject({
      owner: "test-org",
      repo: "test-repo",
      issueNumber: "42",
    });
    expect(capturedComments[0]!.body).toContain("GitHub Agent");
    expect(capturedComments[0]!.body).toContain(
      "Implemented the requested issue fix.",
    );
    expect(capturedComments[0]!.body).not.toContain("Audit");
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(1);
  });

  it("includes an audit link when the AuditLink switch is on", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    const { capturedComments } = setupGithubApiMocks(
      installation.installationId,
    );
    await enableAuditLink(fixture);
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    completedOutput();

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(200);
    expect(capturedComments).toHaveLength(1);
    expect(capturedComments[0]!.body).toContain("Audit");
    expect(capturedComments[0]!.body).toContain(`/activities/${runId}`);
  });

  it("posts a failed run comment with the run error", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    const { capturedComments } = setupGithubApiMocks(
      installation.installationId,
    );
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "failed",
      error: "Agent crashed unexpectedly",
      payload,
    });

    expect(response.status).toBe(200);
    expect(capturedComments).toHaveLength(1);
    expect(capturedComments[0]!.body).toContain("**Error:**");
    expect(capturedComments[0]!.body).toContain("Agent crashed unexpectedly");
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("quotes the trigger comment and removes the trigger reaction", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    const { capturedComments, capturedReactionDeletes } = setupGithubApiMocks(
      installation.installationId,
    );
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
      triggerCommentId: "100",
      triggerReactionId: "200",
      triggerCommentBody: "@vm0 please fix this\nwith context",
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    completedOutput();

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(200);
    expect(capturedComments[0]!.body).toContain("> @vm0 please fix this");
    expect(capturedComments[0]!.body).toContain("> with context");
    expect(capturedReactionDeletes).toStrictEqual([
      { commentId: "100", reactionId: "200" },
    ]);
  });

  it("creates a GitHub issue session for a new issue", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    setupGithubApiMocks(installation.installationId);
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
    };
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    const session = await seedAgentSession(fixture);
    completedOutput();

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(200);
    const issueSession = await findIssueSession({
      installationId: installation.id,
      repo: payload.repo,
      issueNumber: payload.issueNumber,
    });
    expect(issueSession).not.toBeNull();
    expect(issueSession!.agentSessionId).toBe(session.id);
    expect(issueSession!.userId).toBe(fixture.userId);
    expect(issueSession!.lastCommentId).toBe(GITHUB_COMMENT_ID);
  });

  it("updates lastCommentId for an existing issue session on completed runs", async () => {
    const fixture = await track(seedFixture());
    const installation = await seedGithubInstallation({
      composeId: fixture.composeId,
    });
    if (!installation.installationId) {
      throw new Error("Expected active installation to have remote ID");
    }
    mockGithubAppEnv();
    setupGithubApiMocks(installation.installationId);
    const session = await seedAgentSession(fixture);
    const payload: GitHubIssuesPayload = {
      installationId: installation.id,
      repo: "test-org/test-repo",
      issueNumber: 42,
      agentId: fixture.composeId,
      existingSessionId: "existing-session-id",
    };
    await seedIssueSession({
      userId: fixture.userId,
      installationId: installation.id,
      repo: payload.repo,
      issueNumber: payload.issueNumber,
      agentSessionId: session.id,
      lastCommentId: "old-comment-id",
    });
    const { runId, callbackId } = await seedRunAndCallback({
      fixture,
      payload,
    });
    completedOutput();

    const response = await postSignedCallback({
      callbackId,
      runId,
      status: "completed",
      payload,
    });

    expect(response.status).toBe(200);
    const issueSession = await findIssueSession({
      installationId: installation.id,
      repo: payload.repo,
      issueNumber: payload.issueNumber,
    });
    expect(issueSession).not.toBeNull();
    expect(issueSession!.lastCommentId).toBe(GITHUB_COMMENT_ID);
  });
});
