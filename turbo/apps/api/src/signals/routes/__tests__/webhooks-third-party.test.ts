import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { storages } from "@vm0/db/schema/storage";
import { command, createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
createZeroRouteMocks(context);

const GITHUB_WEBHOOK_PATH = "/api/webhooks/github";
const GITHUB_WEBHOOK_SECRET = "github-secret";
const GITHUB_APP_SLUG = "vm0-agent";
const GITHUB_APP_ID = "123456";

interface AppResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

interface GitHubWebhookFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly installationDbId: string;
  readonly remoteInstallationId: string;
  readonly githubUserId: string;
}

interface StripeFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ClerkFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface GitHubUserPayload {
  readonly id: number;
  readonly login: string;
  readonly type: string;
}

interface GitHubLabelPayload {
  readonly id: number;
  readonly name: string;
}

interface GitHubIssuePayload {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly labels: readonly GitHubLabelPayload[];
  readonly user: GitHubUserPayload;
}

interface GitHubRepositoryPayload {
  readonly full_name: string;
}

interface GitHubInstallationRefPayload {
  readonly id: number;
}

interface GitHubIssuesPayload {
  readonly action: string;
  readonly issue: GitHubIssuePayload;
  readonly label?: GitHubLabelPayload;
  readonly repository: GitHubRepositoryPayload;
  readonly installation: GitHubInstallationRefPayload;
  readonly sender: GitHubUserPayload;
}

interface GitHubCommentPayload {
  readonly id: number;
  readonly body: string;
  readonly user: GitHubUserPayload;
}

interface GitHubIssueCommentPayload {
  readonly action: string;
  readonly issue: GitHubIssuePayload;
  readonly comment: GitHubCommentPayload;
  readonly repository: GitHubRepositoryPayload;
  readonly installation: GitHubInstallationRefPayload;
  readonly sender: GitHubUserPayload;
}

interface GitHubInstallationPayload {
  readonly action: string;
  readonly installation: {
    readonly id: number;
    readonly account: {
      readonly id: number;
      readonly login: string;
      readonly type: string;
    };
  };
  readonly sender?: {
    readonly id: number;
    readonly login: string;
  };
}

interface GitHubApiComment {
  readonly id: number;
  readonly user: {
    readonly login: string;
    readonly type: string;
  };
  readonly body: string;
  readonly created_at: string;
}

interface GitHubIssuesPayloadOverrides {
  readonly action?: string;
  readonly labels?: readonly GitHubLabelPayload[];
  readonly label?: GitHubLabelPayload;
  readonly installationId?: string;
  readonly repo?: string;
  readonly issueBody?: string | null;
  readonly issueTitle?: string;
  readonly senderId?: string;
}

interface GitHubIssueCommentPayloadOverrides {
  readonly action?: string;
  readonly labels?: readonly GitHubLabelPayload[];
  readonly commentBody?: string;
  readonly commentId?: number;
  readonly installationId?: string;
  readonly repo?: string;
  readonly senderId?: string;
  readonly senderLogin?: string;
  readonly senderType?: string;
}

function signGithub(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function mockGitHubWebhookEnv(): void {
  mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
  mockOptionalEnv("GITHUB_APP_SLUG", GITHUB_APP_SLUG);
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  context.mocks.s3.send.mockResolvedValue({});
}

function mockGitHubAppCredentials(): void {
  mockOptionalEnv("GITHUB_APP_ID", GITHUB_APP_ID);
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
}

function setupGitHubApiMocks(args: {
  readonly installationId: string;
  readonly comments?: readonly GitHubApiComment[];
}): void {
  server.use(
    http.post(
      `https://api.github.com/app/installations/${args.installationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: "ghs_test_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.get(
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      () => {
        return HttpResponse.json(args.comments ?? []);
      },
    ),
    http.post(
      "https://api.github.com/repos/:owner/:repo/issues/comments/:commentId/reactions",
      () => {
        return HttpResponse.json({ id: 2468 });
      },
    ),
  );
}

function gitHubWebhookHeaders(args: {
  readonly event: string;
  readonly body: string;
  readonly secret?: string;
}): Record<string, string> {
  const secret = args.secret ?? GITHUB_WEBHOOK_SECRET;
  return {
    "content-type": "application/json",
    "x-hub-signature-256": signGithub(secret, args.body),
    "x-github-event": args.event,
    "x-github-delivery": `delivery-${randomUUID()}`,
  };
}

async function postGitHubWebhookBody(args: {
  readonly event: string;
  readonly body: string;
  readonly includeGitHubHeaders?: boolean;
  readonly headers?: HeadersInit;
}): Promise<AppResponse> {
  const headers =
    args.includeGitHubHeaders === false
      ? { "content-type": "application/json" }
      : gitHubWebhookHeaders({ event: args.event, body: args.body });
  const mergedHeaders: Record<string, string> = { ...headers };
  if (args.headers) {
    for (const [key, value] of new Headers(args.headers)) {
      mergedHeaders[key] = value;
    }
  }

  return await postRaw({
    path: GITHUB_WEBHOOK_PATH,
    body: args.body,
    headers: mergedHeaders,
  });
}

async function postGitHubWebhook(args: {
  readonly event: string;
  readonly payload: unknown;
  readonly includeGitHubHeaders?: boolean;
  readonly headers?: HeadersInit;
}): Promise<AppResponse> {
  return await postGitHubWebhookBody({
    event: args.event,
    body: JSON.stringify(args.payload),
    includeGitHubHeaders: args.includeGitHubHeaders,
    headers: args.headers,
  });
}

function githubUser(args: {
  readonly id: string;
  readonly login?: string;
  readonly type?: string;
}): GitHubUserPayload {
  return {
    id: Number(args.id),
    login: args.login ?? "linked-user",
    type: args.type ?? "User",
  };
}

function buildGitHubIssuePayload(
  fixture: GitHubWebhookFixture,
  overrides: GitHubIssuesPayloadOverrides = {},
): GitHubIssuePayload {
  const sender = githubUser({ id: overrides.senderId ?? fixture.githubUserId });
  return {
    number: 42,
    title: overrides.issueTitle ?? "Test Issue",
    body:
      overrides.issueBody !== undefined
        ? overrides.issueBody
        : "This is a test issue body",
    labels: overrides.labels ?? [{ id: 1, name: GITHUB_APP_SLUG }],
    user: sender,
  };
}

function buildGitHubIssuesPayload(
  fixture: GitHubWebhookFixture,
  overrides: GitHubIssuesPayloadOverrides = {},
): GitHubIssuesPayload {
  const sender = githubUser({ id: overrides.senderId ?? fixture.githubUserId });
  return {
    action: overrides.action ?? "opened",
    issue: buildGitHubIssuePayload(fixture, overrides),
    ...(overrides.label ? { label: overrides.label } : {}),
    repository: { full_name: overrides.repo ?? "vm0-ai/vm0" },
    installation: {
      id: Number(overrides.installationId ?? fixture.remoteInstallationId),
    },
    sender,
  };
}

function buildGitHubIssueCommentPayload(
  fixture: GitHubWebhookFixture,
  overrides: GitHubIssueCommentPayloadOverrides = {},
): GitHubIssueCommentPayload {
  const sender = githubUser({
    id: overrides.senderId ?? fixture.githubUserId,
    login: overrides.senderLogin,
    type: overrides.senderType,
  });
  return {
    action: overrides.action ?? "created",
    issue: buildGitHubIssuePayload(fixture, {
      labels: overrides.labels ?? [],
      repo: overrides.repo,
      senderId: overrides.senderId,
    }),
    comment: {
      id: overrides.commentId ?? 77,
      body:
        overrides.commentBody ?? `@${GITHUB_APP_SLUG}[bot] please handle this`,
      user: sender,
    },
    repository: { full_name: overrides.repo ?? "vm0-ai/vm0" },
    installation: {
      id: Number(overrides.installationId ?? fixture.remoteInstallationId),
    },
    sender,
  };
}

function buildGitHubInstallationPayload(args: {
  readonly action?: string;
  readonly installationId: string;
  readonly targetId: string;
  readonly accountLogin?: string;
  readonly senderId?: string;
}): GitHubInstallationPayload {
  return {
    action: args.action ?? "created",
    installation: {
      id: Number(args.installationId),
      account: {
        id: Number(args.targetId),
        login: args.accountLogin ?? "test-org",
        type: "Organization",
      },
    },
    sender: {
      id: Number(args.senderId ?? "12345"),
      login: "installer-user",
    },
  };
}

async function selectGitHubRuns(fixture: GitHubWebhookFixture) {
  const db = store.set(writeDb$);
  return await db
    .select({
      id: agentRuns.id,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      triggerSource: zeroRuns.triggerSource,
    })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(
      and(
        eq(agentRuns.orgId, fixture.orgId),
        eq(agentRuns.userId, fixture.userId),
      ),
    );
}

async function selectGitHubCallbacks(runId: string) {
  const db = store.set(writeDb$);
  return await db
    .select({
      id: agentRunCallbacks.id,
      url: agentRunCallbacks.url,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId));
}

function remoteGitHubId(): string {
  return String(randomInt(1_000_000, 999_999_999));
}

async function postRaw(args: {
  readonly path: string;
  readonly body: string;
  readonly headers?: HeadersInit;
}): Promise<AppResponse> {
  const app = createApp({ signal: context.signal });
  const response = await app.request(args.path, {
    method: "POST",
    headers: args.headers,
    body: args.body,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { status: response.status, body, headers: response.headers };
}

const deleteGitHubFixture$ = command(
  async (
    { set },
    fixture: GitHubWebhookFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const runRows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, fixture.orgId),
          eq(agentRuns.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const runIds = runRows.map((row) => {
      return row.id;
    });
    if (runIds.length > 0) {
      await db
        .delete(agentRunCallbacks)
        .where(inArray(agentRunCallbacks.runId, runIds));
      signal.throwIfAborted();
      await db
        .delete(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, runIds));
      signal.throwIfAborted();
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }
    const installationRows = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.defaultComposeId, fixture.composeId));
    signal.throwIfAborted();
    const installationIds = installationRows.map((row) => {
      return row.id;
    });
    if (installationIds.length > 0) {
      await db
        .delete(githubUserLinks)
        .where(inArray(githubUserLinks.installationId, installationIds));
      signal.throwIfAborted();
      await db
        .delete(githubInstallations)
        .where(inArray(githubInstallations.id, installationIds));
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    await set(deleteUsageInsightFixture$, fixture, signal);
    signal.throwIfAborted();
  },
);

const seedGitHubWebhookFixture$ = command(
  async (
    { set },
    _input: void,
    signal: AbortSignal,
  ): Promise<GitHubWebhookFixture> => {
    const db = set(writeDb$);
    const fixture = await set(seedUsageInsightFixture$, undefined, signal);
    signal.throwIfAborted();
    const name = `github-webhook-${randomUUID().slice(0, 8)}`;
    const versionId = randomUUID();
    const remoteInstallationId = remoteGitHubId();
    const githubUserId = remoteGitHubId();

    const [compose] = await db
      .insert(agentComposes)
      .values({ userId: fixture.userId, orgId: fixture.orgId, name })
      .returning({ id: agentComposes.id });
    signal.throwIfAborted();
    if (!compose) {
      throw new Error("compose insert returned no row");
    }

    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId: compose.id,
      createdBy: fixture.userId,
      content: {
        version: "1.0",
        agents: {
          [name]: {
            framework: "claude-code",
            environment: { ANTHROPIC_API_KEY: "test-key" },
          },
        },
      },
    });
    signal.throwIfAborted();
    await db
      .update(agentComposes)
      .set({ headVersionId: versionId })
      .where(eq(agentComposes.id, compose.id));
    signal.throwIfAborted();
    await db.insert(zeroAgents).values({
      id: compose.id,
      orgId: fixture.orgId,
      owner: fixture.userId,
      name,
      visibility: "public",
      displayName: "GitHub Agent",
      customSkills: [],
    });
    signal.throwIfAborted();
    await db.insert(orgMetadata).values({
      orgId: fixture.orgId,
      credits: 100_000,
      tier: "pro",
    });
    signal.throwIfAborted();
    await db.insert(userCache).values({
      userId: fixture.userId,
      email: "github-webhook@example.com",
      name: "GitHub User",
    });
    signal.throwIfAborted();
    await db.insert(orgMembersMetadata).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      timezone: "UTC",
      creditEnabled: true,
    });
    signal.throwIfAborted();

    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: remoteInstallationId,
        status: "active",
        defaultComposeId: compose.id,
      })
      .returning({ id: githubInstallations.id });
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("installation insert returned no row");
    }

    await db.insert(githubUserLinks).values({
      githubUserId,
      installationId: installation.id,
      vm0UserId: fixture.userId,
    });
    signal.throwIfAborted();

    return {
      ...fixture,
      composeId: compose.id,
      installationDbId: installation.id,
      remoteInstallationId,
      githubUserId,
    };
  },
);

const deleteStripeFixture$ = command(
  async (
    { set },
    fixture: StripeFixture,
    _signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, fixture.orgId));
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
  },
);

const seedStripeFixture$ = command(
  async (
    { set },
    _input: void,
    _signal: AbortSignal,
  ): Promise<StripeFixture> => {
    const db = set(writeDb$);
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await db.insert(orgMetadata).values({
      orgId,
      credits: 0,
      stripeCustomerId: "cus_test",
    });
    await db.insert(orgMembersMetadata).values({
      orgId,
      userId,
      creditEnabled: false,
    });
    return { orgId, userId };
  },
);

const deleteClerkFixture$ = command(
  async (
    { set },
    fixture: ClerkFixture,
    _signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db.delete(storages).where(eq(storages.userId, fixture.userId));
    await db.delete(storages).where(eq(storages.orgId, fixture.orgId));
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.userId, fixture.userId));
    await db
      .delete(orgMembersCache)
      .where(eq(orgMembersCache.userId, fixture.userId));
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    await db.delete(orgCache).where(eq(orgCache.orgId, fixture.orgId));
    await db.delete(userCache).where(eq(userCache.userId, fixture.userId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  },
);

const seedClerkFixture$ = command(
  async (
    { set },
    _input: void,
    _signal: AbortSignal,
  ): Promise<ClerkFixture> => {
    const db = set(writeDb$);
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await db.insert(users).values({ id: userId });
    await db.insert(userCache).values({
      userId,
      email: "deleted-user@example.com",
      name: "Deleted User",
    });
    await db.insert(orgCache).values({
      orgId,
      slug: `deleted-org-${randomUUID()}`,
      name: "Deleted Org",
    });
    await db.insert(orgMetadata).values({ orgId });
    await db.insert(orgMembersCache).values({
      orgId,
      userId,
      role: "admin",
    });
    await db.insert(orgMembersMetadata).values({ orgId, userId });
    return { orgId, userId };
  },
);

const trackGitHub = createFixtureTracker<GitHubWebhookFixture>((fixture) => {
  return store.set(deleteGitHubFixture$, fixture, context.signal);
});
const trackStripe = createFixtureTracker<StripeFixture>((fixture) => {
  return store.set(deleteStripeFixture$, fixture, context.signal);
});
const trackClerk = createFixtureTracker<ClerkFixture>((fixture) => {
  return store.set(deleteClerkFixture$, fixture, context.signal);
});

describe("POST /api/webhooks/github", () => {
  it("returns 503 when GitHub webhook secret is not configured", async () => {
    const response = await postRaw({
      path: GITHUB_WEBHOOK_PATH,
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("rejects requests with missing GitHub webhook headers", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);

    const response = await postGitHubWebhook({
      event: "issues",
      payload: {},
      includeGitHubHeaders: false,
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: "Missing GitHub webhook headers",
    });
  });

  it("rejects invalid GitHub signatures", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);
    const response = await postRaw({
      path: GITHUB_WEBHOOK_PATH,
      body: "{}",
      headers: {
        "x-hub-signature-256": "sha256=bad",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-1",
      },
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({ error: "Invalid signature" });
  });

  it("rejects invalid JSON payloads", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);

    const response = await postGitHubWebhookBody({
      event: "issues",
      body: "not-json",
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({ error: "Invalid JSON payload" });
  });

  it("rejects invalid event payload structures", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);

    const response = await postGitHubWebhook({
      event: "issues",
      payload: { action: "opened" },
    });

    expect(response.status).toBe(400);
    expect(response.body).toStrictEqual({ error: "Invalid payload structure" });
  });

  it("responds to GitHub ping", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);

    const response = await postGitHubWebhook({
      event: "ping",
      payload: { zen: "testing" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ message: "pong" });
  });

  it("dispatches opened issues with the app slug label and GitHub context", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [
        {
          id: 12,
          user: { login: "maintainer", type: "User" },
          body: "Earlier discussion",
          created_at: "2026-05-20T00:00:00Z",
        },
      ],
    });

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, { action: "opened" }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain(
      "Based on the GitHub issue above and its discussion",
    );
    expect(runs[0]?.appendSystemPrompt).toContain(
      "You are currently running inside: GitHub",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("This is a test issue body");
    expect(runs[0]?.appendSystemPrompt).toContain("Earlier discussion");
    expect(runs[0]?.triggerSource).toBe("github");

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.url).toContain("/api/internal/callbacks/github");
    expect(callbacks[0]?.payload).toMatchObject({
      installationId: fixture.installationDbId,
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      agentId: fixture.composeId,
    });
  });

  it("dispatches labeled issues only when the added label is the app slug", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "labeled",
        labels: [
          { id: 1, name: GITHUB_APP_SLUG },
          { id: 2, name: "enhancement" },
        ],
        label: { id: 1, name: GITHUB_APP_SLUG },
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("This is a test issue body");
  });

  it("does not dispatch ignored issue actions or non-matching labels", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const ignoredPayloads: readonly GitHubIssuesPayload[] = [
      buildGitHubIssuesPayload(fixture, {
        action: "opened",
        labels: [{ id: 2, name: "bug" }],
      }),
      buildGitHubIssuesPayload(fixture, {
        action: "labeled",
        labels: [
          { id: 1, name: GITHUB_APP_SLUG },
          { id: 2, name: "enhancement" },
        ],
        label: { id: 2, name: "enhancement" },
      }),
      ...["closed", "edited", "reopened", "deleted"].map((action) => {
        return buildGitHubIssuesPayload(fixture, { action });
      }),
    ];

    for (const payload of ignoredPayloads) {
      const response = await postGitHubWebhook({
        event: "issues",
        payload,
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe("OK");
      await clearAllDetached();
    }

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(0);
  });

  it("uses the issue title when an opened issue has a null body", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [],
    });

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "opened",
        issueBody: null,
        issueTitle: "Fallback title",
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.appendSystemPrompt).toContain("Fallback title");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "You are currently running inside: GitHub",
    );
  });

  it("dispatches GitHub issue comments through API-native run creation", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe(`@${GITHUB_APP_SLUG}[bot] please handle this`);
    expect(runs[0]?.triggerSource).toBe("github");

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0]?.payload).toMatchObject({
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      triggerCommentId: "77",
      triggerCommentBody: `@${GITHUB_APP_SLUG}[bot] please handle this`,
    });
  });

  it("does not dispatch ignored issue comments", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const ignoredPayloads: readonly GitHubIssueCommentPayload[] = [
      buildGitHubIssueCommentPayload(fixture, {
        labels: [{ id: 1, name: GITHUB_APP_SLUG }],
        commentBody: "Can you help me fix this?",
      }),
      buildGitHubIssueCommentPayload(fixture, {
        labels: [{ id: 2, name: "bug" }],
        commentBody: "Just a regular comment",
      }),
      buildGitHubIssueCommentPayload(fixture, {
        commentBody: "Here is the analysis...",
        senderType: "Bot",
        senderLogin: `${GITHUB_APP_SLUG}[bot]`,
      }),
      buildGitHubIssueCommentPayload(fixture, { action: "edited" }),
      buildGitHubIssueCommentPayload(fixture, { action: "deleted" }),
    ];

    for (const payload of ignoredPayloads) {
      const response = await postGitHubWebhook({
        event: "issue_comment",
        payload,
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe("OK");
      await clearAllDetached();
    }

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(0);
  });

  it("acknowledges dispatch failures such as missing installations", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "opened",
        installationId: remoteGitHubId(),
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(0);
  });

  it("acknowledges unknown GitHub events", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", GITHUB_WEBHOOK_SECRET);

    const response = await postGitHubWebhook({
      event: "push",
      payload: { ref: "refs/heads/main" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("activates matching pending installations", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();

    const db = store.set(writeDb$);
    const targetId = remoteGitHubId();
    const installationId = remoteGitHubId();
    await db.insert(githubInstallations).values({
      status: "pending",
      targetId,
      targetType: "Organization",
      targetName: "pending-org",
      defaultComposeId: fixture.composeId,
    });
    setupGitHubApiMocks({ installationId });

    const response = await postGitHubWebhook({
      event: "installation",
      payload: buildGitHubInstallationPayload({
        installationId,
        targetId,
        accountLogin: "activated-org",
        senderId: fixture.githubUserId,
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const [installation] = await db
      .select({
        status: githubInstallations.status,
        installationId: githubInstallations.installationId,
        encryptedAccessToken: githubInstallations.encryptedAccessToken,
        targetName: githubInstallations.targetName,
        adminGithubUserId: githubInstallations.adminGithubUserId,
      })
      .from(githubInstallations)
      .where(eq(githubInstallations.targetId, targetId));

    expect(installation).toMatchObject({
      status: "active",
      installationId,
      targetName: "activated-org",
      adminGithubUserId: fixture.githubUserId,
    });
    expect(installation?.encryptedAccessToken).toStrictEqual(
      expect.any(String),
    );
  });

  it("ignores installation events without a matching pending record", async () => {
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "installation",
      payload: buildGitHubInstallationPayload({
        installationId: remoteGitHubId(),
        targetId: remoteGitHubId(),
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("ignores non-created installation events", async () => {
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "installation",
      payload: buildGitHubInstallationPayload({
        action: "deleted",
        installationId: remoteGitHubId(),
        targetId: remoteGitHubId(),
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });
});

describe("POST /api/webhooks/stripe", () => {
  it("returns 503 when Stripe webhook secret is not configured", async () => {
    const response = await postRaw({
      path: "/api/webhooks/stripe",
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "Stripe billing is not configured",
    });
  });

  it("rejects invalid Stripe signatures", async () => {
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "stripe-secret");
    context.mocks.stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const response = await postRaw({
      path: "/api/webhooks/stripe",
      body: "{}",
      headers: { "stripe-signature": "bad" },
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("updates subscription metadata from checkout completion", async () => {
    const fixture = await trackStripe(
      store.set(seedStripeFixture$, undefined, context.signal),
    );
    mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "stripe-secret");
    mockEnv(
      "ZERO_PRICE",
      JSON.stringify({ pro: ["price_pro"], team: ["price_team"] }),
    );
    context.mocks.stripe.webhooks.constructEvent.mockReturnValue({
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test",
          subscription: "sub_test",
          customer: "cus_test",
          metadata: null,
        },
      },
    });
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: "sub_test",
      status: "active",
      items: {
        data: [
          {
            price: { id: "price_pro" },
            current_period_end: 1_800_000_000,
          },
        ],
      },
    });

    const response = await postRaw({
      path: "/api/webhooks/stripe",
      body: "{}",
      headers: { "stripe-signature": "valid" },
    });

    expect(response.status).toBe(200);
    const db = store.set(writeDb$);
    const [row] = await db
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    expect(row).toStrictEqual({
      tier: "pro",
      stripeSubscriptionId: "sub_test",
      subscriptionStatus: "active",
    });
  });
});

describe("POST /api/webhooks/clerk", () => {
  it("rejects invalid Clerk signatures", async () => {
    context.mocks.clerk.verifyWebhook.mockRejectedValue(
      new Error("invalid signature"),
    );

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("passes the request and configured signing secret to Clerk verification", async () => {
    mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "clerk-secret");
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: `user_${randomUUID()}` },
    });

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });

    expect(response.status).toBe(200);
    const call = context.mocks.clerk.verifyWebhook.mock.calls[0];
    expect(call?.[0]).toBeInstanceOf(Request);
    expect(call?.[1]).toStrictEqual({ signingSecret: "clerk-secret" });
  });

  it("returns OK for unhandled event types", async () => {
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "user.created",
      data: { id: `user_${randomUUID()}` },
    });

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("runs organization deletion cleanup after a Clerk organization.deleted event", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { id: fixture.orgId },
    });
    context.mocks.s3.send.mockResolvedValue({});

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const cacheRows = await db
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, fixture.orgId));
    const metadataRows = await db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, fixture.orgId));
    const membershipRows = await db
      .select({ orgId: orgMembersCache.orgId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.orgId, fixture.orgId));
    expect(cacheRows).toHaveLength(0);
    expect(metadataRows).toHaveLength(0);
    expect(membershipRows).toHaveLength(0);
  });

  it("does not schedule organization deletion cleanup without an org ID", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { id: undefined },
    });

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const cacheRows = await db
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, fixture.orgId));
    expect(cacheRows).toHaveLength(1);
  });

  it("does not surface organization cleanup errors in the response", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    await store
      .set(writeDb$)
      .insert(storages)
      .values({
        userId: fixture.userId,
        orgId: fixture.orgId,
        name: "org-memory",
        type: "memory",
        s3Prefix: `orgs/${fixture.orgId}/memory`,
      });
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { id: fixture.orgId },
    });
    context.mocks.s3.send.mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });

    await expect(clearAllDetached()).resolves.toBeUndefined();
    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("runs user deletion cleanup after a Clerk user.deleted event", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "user.deleted",
      data: { id: fixture.userId },
    });
    context.mocks.s3.send.mockResolvedValue({});

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const cacheRows = await db
      .select({ userId: userCache.userId })
      .from(userCache)
      .where(eq(userCache.userId, fixture.userId));
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, fixture.userId));
    const orgRows = await db
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, fixture.orgId));
    expect(cacheRows).toHaveLength(0);
    expect(userRows).toHaveLength(0);
    expect(orgRows).toHaveLength(1);
  });

  it("does not schedule user deletion cleanup without a user ID", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "user.deleted",
      data: { id: undefined },
    });

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, fixture.userId));
    expect(userRows).toHaveLength(1);
  });

  it("continues user deletion cleanup when user S3 cleanup fails", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    const db = store.set(writeDb$);
    await db.insert(storages).values({
      userId: fixture.userId,
      orgId: `org_${randomUUID()}`,
      name: "memory",
      type: "memory",
      s3Prefix: `users/${fixture.userId}/memory`,
    });
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "user.deleted",
      data: { id: fixture.userId },
    });
    context.mocks.s3.send.mockRejectedValueOnce(new Error("R2 unavailable"));

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const cacheRows = await db
      .select({ userId: userCache.userId })
      .from(userCache)
      .where(eq(userCache.userId, fixture.userId));
    const userRows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, fixture.userId));
    const storageRows = await db
      .select({ id: storages.id })
      .from(storages)
      .where(eq(storages.userId, fixture.userId));
    expect(cacheRows).toHaveLength(0);
    expect(userRows).toHaveLength(0);
    expect(storageRows).toHaveLength(0);
  });

  it("returns OK for organizationMembership.deleted without cleanup", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    context.mocks.clerk.verifyWebhook.mockResolvedValue({
      type: "organizationMembership.deleted",
      data: {
        organization: { id: fixture.orgId },
        public_user_data: { user_id: fixture.userId },
      },
    });

    const response = await postRaw({
      path: "/api/webhooks/clerk",
      body: "{}",
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const membershipRows = await db
      .select({ userId: orgMembersCache.userId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.userId, fixture.userId));
    expect(membershipRows).toHaveLength(1);
  });
});
