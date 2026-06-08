import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import type { StoredExecutionContext } from "@vm0/api-contracts/contracts/runners";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRunQueue } from "@vm0/db/schema/agent-run-queue";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { connectorOauthDeviceAuthorizationSessions } from "@vm0/db/schema/connector-oauth-device-authorization-session";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubIssueSessions } from "@vm0/db/schema/github-issue-session";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { githubLabelListeners } from "@vm0/db/schema/github-label-listener";
import { modelProviderAuthSessions } from "@vm0/db/schema/model-provider-auth-session";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { userCache } from "@vm0/db/schema/user-cache";
import { users } from "@vm0/db/schema/user";
import { userPermissionGrants } from "@vm0/db/schema/user-permission-grant";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
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
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { writeDb$ } from "../../external/db";
import { mockStripeClient } from "../../external/stripe-client";
import {
  encryptQueuedRunnerJobPayload,
  queuedRunnerJobPayload,
} from "../../services/agent-run-queue-payload.service";
import { clearAllDetached } from "../../utils";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
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
const SLACK_CONNECTOR = "slack";
const SLACK_READ_PERMISSION = "channels:read";
const SLACK_WRITE_PERMISSION = "chat:write";

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
  readonly stripeCustomerId: string;
}

interface ClerkFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ClerkAgentFixture {
  readonly agentId: string;
  readonly ownerUserId: string;
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

interface GitHubPullRequestPayload {
  readonly action: string;
  readonly pull_request: GitHubIssuePayload;
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

interface CapturedGitHubIssueComment {
  readonly body: string;
}

interface CapturedRunCallback {
  readonly callbackId: string;
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly payload?: unknown;
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

interface StripeBillingRow {
  readonly credits: number;
  readonly tier: string;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly subscriptionStatus: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pendingSubscriptionScheduleId: string | null;
  readonly pendingSubscriptionTargetTier: string | null;
  readonly pendingSubscriptionChangeAt: Date | null;
  readonly lastProcessedInvoiceId: string | null;
  readonly autoRechargePendingAt: Date | null;
  readonly onboardingPaymentPending: boolean;
}

interface StripeCreditExpiresRow {
  readonly source: string;
  readonly stripeInvoiceId: string | null;
  readonly amount: number;
  readonly remaining: number;
  readonly expiresAt: Date;
}

type StripeOrgMetadataPatch = Partial<typeof orgMetadata.$inferInsert>;

const STRIPE_WEBHOOK_PATH = "/api/webhooks/stripe";
const STRIPE_WEBHOOK_SECRET = "stripe-secret";
const STRIPE_PRICE_PRO = "price_pro";
const STRIPE_PRICE_TEAM = "price_team";
const STRIPE_PRICE_TEAM_LEGACY = "price_team_legacy";
const STRIPE_PRICE_MAP = JSON.stringify({
  pro: [STRIPE_PRICE_PRO],
  team: [STRIPE_PRICE_TEAM, STRIPE_PRICE_TEAM_LEGACY],
});
const STRIPE_ONE_TIME_CAMPAIGN = JSON.stringify({
  ZERO100: {
    priceId: "price_campaign",
    couponId: "ZERO100",
  },
});

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
      "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
      () => {
        return HttpResponse.json({ id: 9876 });
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

function buildGitHubPullRequestPayload(
  fixture: GitHubWebhookFixture,
  overrides: GitHubIssuesPayloadOverrides = {},
): GitHubPullRequestPayload {
  const sender = githubUser({ id: overrides.senderId ?? fixture.githubUserId });
  return {
    action: overrides.action ?? "opened",
    pull_request: buildGitHubIssuePayload(fixture, {
      ...overrides,
      issueTitle: overrides.issueTitle ?? "Test Pull Request",
    }),
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
      status: agentRuns.status,
      error: agentRuns.error,
      prompt: agentRuns.prompt,
      sessionId: agentRuns.sessionId,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      triggerSource: zeroRuns.triggerSource,
      modelProvider: zeroRuns.modelProvider,
      selectedModel: zeroRuns.selectedModel,
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

function expectGitHubIssueContextPrompt(
  prompt: string | null | undefined,
): void {
  expect(prompt).toContain("You are currently running inside: GitHub");
  expect(prompt).toContain(`Bot username: @${GITHUB_APP_SLUG}[bot]`);
  expect(prompt).toContain("zero github label-listener -h");
  expect(prompt).toContain(
    "Issue URL: https://github.com/vm0-ai/vm0/issues/42",
  );
  expect(prompt).toContain("# GitHub Issue Context");
  expect(prompt).not.toContain("# GitHub Label Trigger");
  expect(prompt).toContain("Matched label: vm0-agent");
  expect(prompt).toContain("- RELATIVE_INDEX: -2");
  expect(prompt).toContain("- MSG_ID: issue:42");
  expect(prompt).toContain("username: @linked-user, type: User");
  expect(prompt).not.toContain("## Description");
  expect(prompt).not.toContain("## Comments");
  expect(prompt).toContain("This is a test issue body");
  expect(prompt).toContain("Earlier discussion");
}

function remoteGitHubId(): string {
  return String(randomInt(1_000_000_000_000, 9_000_000_000_000));
}

async function seedGitHubModelRoute(args: {
  readonly fixture: GitHubWebhookFixture;
  readonly selectedModel?: string | null;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(orgModelPolicies).values([
    {
      orgId: args.fixture.orgId,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: args.fixture.userId,
      updatedByUserId: args.fixture.userId,
    },
    {
      orgId: args.fixture.orgId,
      model: "claude-opus-4-7",
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: args.fixture.userId,
      updatedByUserId: args.fixture.userId,
    },
  ]);
  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "vm0-key-claude-sonnet-4-6",
      label: args.fixture.composeId,
    },
    {
      vendor: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "vm0-key-claude-opus-4-7",
      label: args.fixture.composeId,
    },
  ]);
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: args.fixture.orgId,
      userId: args.fixture.userId,
      selectedModel: args.selectedModel ?? null,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { selectedModel: args.selectedModel ?? null },
    });
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

function stripeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function mockStripeWebhookEnv(): void {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", STRIPE_WEBHOOK_SECRET);
  mockEnv("ZERO_PRICE", STRIPE_PRICE_MAP);
  mockEnv("ZERO_ONE_TIME_CAMPAIGN", STRIPE_ONE_TIME_CAMPAIGN);
  mockStripeClient(
    context.mocks.stripe as unknown as Parameters<typeof mockStripeClient>[0],
  );
}

function invoiceLinesWithSubscriptionPeriod(periodEnd: number): {
  readonly data: readonly {
    readonly period: { readonly end: number };
    readonly parent: { readonly type: "subscription_item_details" };
  }[];
} {
  return {
    data: [
      {
        period: { end: periodEnd },
        parent: { type: "subscription_item_details" },
      },
    ],
  };
}

async function postStripeWebhookEvent(args: {
  readonly type: string;
  readonly dataObject: Record<string, unknown>;
  readonly previousAttributes?: Record<string, unknown>;
  readonly body?: string;
}): Promise<AppResponse> {
  context.mocks.stripe.webhooks.constructEvent.mockReturnValue({
    id: stripeId("evt"),
    type: args.type,
    data: {
      object: args.dataObject,
      ...(args.previousAttributes === undefined
        ? {}
        : { previous_attributes: args.previousAttributes }),
    },
  });

  return await postRaw({
    path: STRIPE_WEBHOOK_PATH,
    body: args.body ?? JSON.stringify({ type: args.type }),
    headers: { "stripe-signature": "valid" },
  });
}

async function updateStripeOrg(
  fixture: StripeFixture,
  values: StripeOrgMetadataPatch,
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .update(orgMetadata)
    .set(values)
    .where(eq(orgMetadata.orgId, fixture.orgId));
}

async function selectStripeBilling(
  fixture: StripeFixture,
): Promise<StripeBillingRow> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      credits: orgMetadata.credits,
      tier: orgMetadata.tier,
      stripeCustomerId: orgMetadata.stripeCustomerId,
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
      subscriptionStatus: orgMetadata.subscriptionStatus,
      currentPeriodEnd: orgMetadata.currentPeriodEnd,
      cancelAtPeriodEnd: orgMetadata.cancelAtPeriodEnd,
      pendingSubscriptionScheduleId: orgMetadata.pendingSubscriptionScheduleId,
      pendingSubscriptionTargetTier: orgMetadata.pendingSubscriptionTargetTier,
      pendingSubscriptionChangeAt: orgMetadata.pendingSubscriptionChangeAt,
      lastProcessedInvoiceId: orgMetadata.lastProcessedInvoiceId,
      autoRechargePendingAt: orgMetadata.autoRechargePendingAt,
      onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, fixture.orgId));

  if (!row) {
    throw new Error(`missing Stripe fixture org ${fixture.orgId}`);
  }

  return row;
}

async function insertStripeCreditExpiresRecord(
  fixture: StripeFixture,
  values: {
    readonly source?: string;
    readonly stripeInvoiceId: string;
    readonly amount: number;
    readonly remaining?: number;
    readonly expiresAt: Date;
  },
): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(creditExpiresRecord).values({
    orgId: fixture.orgId,
    source: values.source ?? "subscription_renewal",
    stripeInvoiceId: values.stripeInvoiceId,
    amount: values.amount,
    remaining: values.remaining ?? values.amount,
    expiresAt: values.expiresAt,
  });
}

async function selectStripeCreditExpiresRecords(
  fixture: StripeFixture,
): Promise<readonly StripeCreditExpiresRow[]> {
  const db = store.set(writeDb$);
  return await db
    .select({
      source: creditExpiresRecord.source,
      stripeInvoiceId: creditExpiresRecord.stripeInvoiceId,
      amount: creditExpiresRecord.amount,
      remaining: creditExpiresRecord.remaining,
      expiresAt: creditExpiresRecord.expiresAt,
    })
    .from(creditExpiresRecord)
    .where(eq(creditExpiresRecord.orgId, fixture.orgId));
}

async function seedStripeRun(
  fixture: StripeFixture,
  args: {
    readonly composeId: string;
    readonly status: string;
    readonly createdAt?: Date;
    readonly startedAt?: Date | null;
  },
): Promise<string> {
  const { runId } = await store.set(
    seedRun$,
    {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId: args.composeId,
      status: args.status,
      createdAt: args.createdAt,
      startedAt: args.startedAt,
    },
    context.signal,
  );
  return runId;
}

async function seedStripeQueuedRun(
  fixture: StripeFixture,
  args: {
    readonly composeId: string;
    readonly createdAt: Date;
    readonly runnerGroup?: string;
  },
): Promise<string> {
  const db = store.set(writeDb$);
  const runId = await seedStripeRun(fixture, {
    composeId: args.composeId,
    status: "queued",
    createdAt: args.createdAt,
  });
  const runnerGroup = args.runnerGroup ?? "vm0/test";
  const executionContext = {
    storageManifest: null,
    environment: null,
    resumeSession: null,
    encryptedSecrets: null,
    cliAgentType: "codex",
  } satisfies StoredExecutionContext;

  await db.insert(agentRunQueue).values({
    runId,
    orgId: fixture.orgId,
    userId: fixture.userId,
    encryptedParams: await encryptQueuedRunnerJobPayload(
      queuedRunnerJobPayload({
        runnerGroup,
        profile: "vm0/default",
        sessionId: null,
        executionContext,
      }),
    ),
    createdAt: args.createdAt,
    expiresAt: new Date(nowDate().getTime() + 60_000),
  });

  return runId;
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
    await db
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.composeId));
    signal.throwIfAborted();
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
    await db
      .update(orgMetadata)
      .set({
        credits: 100_000,
        tier: "pro",
      })
      .where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.insert(vm0ApiKeys).values({
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: "vm0-key-deepseek-v4-pro",
      label: compose.id,
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
    });
    signal.throwIfAborted();

    const [installation] = await db
      .insert(githubInstallations)
      .values({
        installationId: remoteInstallationId,
        status: "active",
        orgId: fixture.orgId,
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
    await db.insert(githubLabelListeners).values({
      installationId: installation.id,
      orgId: fixture.orgId,
      createdByUserId: fixture.userId,
      labelName: GITHUB_APP_SLUG,
      labelNameNormalized: GITHUB_APP_SLUG.toLowerCase(),
      triggerMode: "created_by_me",
      prompt: "Handle this labeled GitHub work",
      composeId: compose.id,
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
        .delete(agentRunQueue)
        .where(inArray(agentRunQueue.runId, runIds));
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
    await db
      .delete(agentSessions)
      .where(
        and(
          eq(agentSessions.orgId, fixture.orgId),
          eq(agentSessions.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const composeRows = await db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.orgId, fixture.orgId),
          eq(agentComposes.userId, fixture.userId),
        ),
      );
    signal.throwIfAborted();
    const composeIds = composeRows.map((row) => {
      return row.id;
    });
    if (composeIds.length > 0) {
      await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
      signal.throwIfAborted();
      await db
        .delete(agentComposeVersions)
        .where(inArray(agentComposeVersions.composeId, composeIds));
      signal.throwIfAborted();
      await db
        .delete(agentComposes)
        .where(inArray(agentComposes.id, composeIds));
      signal.throwIfAborted();
    }
    await db
      .delete(creditExpiresRecord)
      .where(eq(creditExpiresRecord.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db
      .delete(orgMembersMetadata)
      .where(eq(orgMembersMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, fixture.orgId));
    signal.throwIfAborted();
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
    const stripeCustomerId = stripeId("cus");
    await db.insert(orgMetadata).values({
      orgId,
      credits: 0,
      stripeCustomerId,
    });
    await db.insert(orgMembersMetadata).values({
      orgId,
      userId,
    });
    return { orgId, userId, stripeCustomerId };
  },
);

const deleteClerkFixture$ = command(
  async (
    { set },
    fixture: ClerkFixture,
    _signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .delete(connectorOauthDeviceAuthorizationSessions)
      .where(
        eq(connectorOauthDeviceAuthorizationSessions.userId, fixture.userId),
      );
    await db
      .delete(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.userId, fixture.userId));
    await db
      .delete(connectorOauthDeviceAuthorizationSessions)
      .where(
        eq(connectorOauthDeviceAuthorizationSessions.orgId, fixture.orgId),
      );
    await db
      .delete(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.orgId, fixture.orgId));
    await db
      .delete(userPermissionGrants)
      .where(eq(userPermissionGrants.orgId, fixture.orgId));
    await db.delete(zeroAgents).where(eq(zeroAgents.orgId, fixture.orgId));
    await db
      .delete(agentComposes)
      .where(eq(agentComposes.orgId, fixture.orgId));
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

async function seedClerkAgent(
  fixture: ClerkFixture,
  ownerUserId = `user_${randomUUID()}`,
): Promise<ClerkAgentFixture> {
  const db = store.set(writeDb$);
  const name = `clerk-cleanup-${randomUUID().slice(0, 8)}`;

  const [compose] = await db
    .insert(agentComposes)
    .values({ userId: ownerUserId, orgId: fixture.orgId, name })
    .returning({ id: agentComposes.id });
  if (!compose) {
    throw new Error("compose insert returned no row");
  }

  await db.insert(zeroAgents).values({
    id: compose.id,
    orgId: fixture.orgId,
    owner: ownerUserId,
    name,
    visibility: "public",
    displayName: "Clerk cleanup agent",
    customSkills: [],
  });

  return { agentId: compose.id, ownerUserId };
}

async function seedClerkOauthDeviceAuthSession(
  fixture: ClerkFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(connectorOauthDeviceAuthorizationSessions)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "test-oauth-device",
      authMethod: "oauth",
      sessionTokenHash: `test-session-token-${randomUUID()}`,
      encryptedProviderState: "encrypted-provider-state",
      userCode: "TEST-DEVICE",
      verificationUri: "https://oauth-device.test/device",
      intervalSeconds: 5,
      expiresAt: new Date(nowDate().getTime() + 600_000),
    });
}

async function seedClerkModelProviderAuthSession(
  fixture: ClerkFixture,
): Promise<void> {
  await store
    .set(writeDb$)
    .insert(modelProviderAuthSessions)
    .values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorType: "codex-oauth-token",
      source: "codex-device-auth",
      status: "awaiting_user_approval",
      approvalUrl: "https://auth.test/device",
      verificationCode: "TEST-CODE",
      encryptedProviderState: "encrypted-provider-state",
      expiresAt: new Date(nowDate().getTime() + 600_000),
    });
}

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
    await seedGitHubModelRoute({
      fixture,
      selectedModel: "claude-opus-4-7",
    });
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
    expect(runs[0]?.prompt).toBe("Handle this labeled GitHub work");
    expectGitHubIssueContextPrompt(runs[0]?.appendSystemPrompt);
    expect(runs[0]?.triggerSource).toBe("github");
    expect(runs[0]?.modelProvider).toBe("vm0");
    expect(runs[0]?.selectedModel).toBe("claude-opus-4-7");

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

  it("adds GitHub file blocks from issue attachments to the context prompt", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    await seedGitHubModelRoute({ fixture });
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [],
    });
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "opened",
        issueBody: `Please inspect this attachment:\n\n![screenshot.png](${fileUrl})`,
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.appendSystemPrompt).toContain("[GitHub file]");
    expect(runs[0]?.appendSystemPrompt).toContain(`[URL] ${fileUrl}`);
    expect(runs[0]?.appendSystemPrompt).toContain("[FILENAME] screenshot.png");
    expect(runs[0]?.appendSystemPrompt).not.toContain(
      `https://cdn.vm7.io/artifacts/${fixture.userId}/`,
    );
    expect(runs[0]?.appendSystemPrompt).not.toContain(
      `![screenshot.png](${fileUrl})`,
    );
    expect(runs[0]?.appendSystemPrompt).not.toContain(
      "GitHub issue and pull request attachments are shown as [GitHub file] blocks.",
    );
  });

  it("posts a formatted failure comment when the GitHub trigger run is rejected", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
    });

    const repo = `vm0-ai/failure-comment-${fixture.composeId.slice(0, 8)}`;
    const capturedComments: CapturedGitHubIssueComment[] = [];
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ params, request }) => {
          const body = (await request.json()) as { readonly body: string };
          if (params.owner === "vm0-ai" && params.repo === repo.split("/")[1]) {
            capturedComments.push({ body: body.body });
          }
          return HttpResponse.json({ id: 9876 });
        },
      ),
    );

    await store
      .set(writeDb$)
      .update(zeroAgents)
      .set({
        owner: `user_${randomUUID()}`,
        visibility: "private",
      })
      .where(eq(zeroAgents.id, fixture.composeId));

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, { action: "opened", repo }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(capturedComments).toHaveLength(1);
    expect(capturedComments[0]?.body).toContain(
      "Oops, something went wrong. Please try again later.",
    );
    expect(capturedComments[0]?.body).not.toContain("Failed to start");
    await expect(selectGitHubRuns(fixture)).resolves.toHaveLength(0);
  });

  it("lets failed GitHub trigger runs with callbacks report the failure", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
    });

    const repo = `vm0-ai/callback-failure-${fixture.composeId.slice(0, 8)}`;
    const capturedComments: CapturedGitHubIssueComment[] = [];
    const capturedCallbacks: CapturedRunCallback[] = [];
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ params, request }) => {
          const body = (await request.json()) as { readonly body: string };
          if (params.owner === "vm0-ai" && params.repo === repo.split("/")[1]) {
            capturedComments.push({ body: body.body });
          }
          return HttpResponse.json({ id: 9876 });
        },
      ),
      http.post(
        "http://localhost:3000/api/internal/callbacks/github/issues",
        async ({ request }) => {
          const body = (await request.json()) as CapturedRunCallback;
          capturedCallbacks.push(body);
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    const db = store.set(writeDb$);
    const [compose] = await db
      .select({ name: agentComposes.name })
      .from(agentComposes)
      .where(eq(agentComposes.id, fixture.composeId))
      .limit(1);
    if (!compose) {
      throw new Error("GitHub fixture compose not found");
    }
    await db
      .update(agentComposeVersions)
      .set({
        content: {
          version: "1.0",
          agents: {
            [compose.name]: {
              framework: "claude-code",
              environment: { ANTHROPIC_API_KEY: "test-key" },
              experimental_runner: { group: "custom/test" },
            },
          },
        },
      })
      .where(eq(agentComposeVersions.composeId, fixture.composeId));

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, { action: "opened", repo }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(capturedComments).toHaveLength(0);
    expect(capturedCallbacks).toHaveLength(1);
    expect(capturedCallbacks[0]?.status).toBe("failed");
    expect(capturedCallbacks[0]?.error).toBe(
      "Only vm0/* runner groups are supported",
    );

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(capturedCallbacks[0]?.runId);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("Only vm0/* runner groups are supported");
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
    expect(runs[0]?.prompt).toBe("Handle this labeled GitHub work");
  });

  it("starts a new session for label triggers on a GitHub issue with an existing session", async () => {
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
        {
          id: 13,
          user: { login: "maintainer", type: "User" },
          body: "New detail",
          created_at: "2026-05-21T00:00:00Z",
        },
      ],
    });
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
      throw new Error("agent session insert returned no row");
    }
    await db.insert(githubIssueSessions).values({
      userId: fixture.userId,
      installationId: fixture.installationDbId,
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      agentSessionId: session.id,
      lastCommentId: "12",
    });

    const response = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "labeled",
        labels: [{ id: 1, name: GITHUB_APP_SLUG }],
        label: { id: 1, name: GITHUB_APP_SLUG },
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toStrictEqual(expect.any(String));
    expect(runs[0]?.sessionId).not.toBe(session.id);
    expect(runs[0]?.appendSystemPrompt).toContain("Earlier discussion");
    expect(runs[0]?.appendSystemPrompt).toContain("New detail");
    expect(runs[0]?.appendSystemPrompt).toContain("- MSG_ID: issue:42");
    expect(runs[0]?.appendSystemPrompt).toContain("- MSG_ID: comment:12");
    expect(runs[0]?.appendSystemPrompt).toContain("- MSG_ID: comment:13");

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks[0]?.payload).toMatchObject({
      sessionContinuityEnabled: false,
    });
    expect(callbacks[0]?.payload).not.toHaveProperty("existingSessionId");
  });

  it("dispatches pull requests with a matching label listener", async () => {
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
      event: "pull_request",
      payload: buildGitHubPullRequestPayload(fixture, {
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
    expect(runs[0]?.prompt).toBe("Handle this labeled GitHub work");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "Pull Request URL: https://github.com/vm0-ai/vm0/pull/42",
    );
    expect(runs[0]?.appendSystemPrompt).toContain(
      "# GitHub Pull Request Context",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("Pull Request: #42");
  });

  it("respects the label listener trigger mode", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    await seedGitHubModelRoute({ fixture });
    mockGitHubWebhookEnv();
    const otherGithubUserId = remoteGitHubId();

    const createdByMeResponse = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "opened",
        senderId: otherGithubUserId,
      }),
    });
    await clearAllDetached();
    expect(createdByMeResponse.status).toBe(200);
    await expect(selectGitHubRuns(fixture)).resolves.toHaveLength(0);

    await store
      .set(writeDb$)
      .update(githubLabelListeners)
      .set({ triggerMode: "anyone" })
      .where(eq(githubLabelListeners.installationId, fixture.installationDbId));

    const anyoneResponse = await postGitHubWebhook({
      event: "issues",
      payload: buildGitHubIssuesPayload(fixture, {
        action: "opened",
        senderId: otherGithubUserId,
      }),
    });
    await clearAllDetached();

    expect(anyoneResponse.status).toBe(200);
    await expect(selectGitHubRuns(fixture)).resolves.toHaveLength(1);
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
    await seedGitHubModelRoute({ fixture });
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

  it("dispatches GitHub issue comments that mention the app bot", async () => {
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
        {
          id: 77,
          user: { login: "linked-user", type: "User" },
          body: `@${GITHUB_APP_SLUG}[bot] please handle this`,
          created_at: "2026-05-21T00:00:00Z",
        },
      ],
    });

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("please handle this");
    expect(runs[0]?.triggerSource).toBe("github");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "Matched trigger: @vm0-agent[bot] mention",
    );
    expect(runs[0]?.appendSystemPrompt).toContain("Earlier discussion");
    expect(runs[0]?.appendSystemPrompt).not.toContain(
      "@vm0-agent[bot] please handle this",
    );

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks[0]?.payload).toMatchObject({
      installationId: fixture.installationDbId,
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      agentId: fixture.composeId,
      triggerCommentId: "77",
      triggerReactionId: "2468",
      triggerCommentBody: `@${GITHUB_APP_SLUG}[bot] please handle this`,
    });
  });

  it("dispatches GitHub issue comments that mention the Zero alias", async () => {
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
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture, {
        commentId: 88,
        commentBody: "@Zero please handle this",
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("please handle this");
    expect(runs[0]?.appendSystemPrompt).toContain(
      "Matched trigger: @vm0-agent[bot] mention",
    );

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks[0]?.payload).toMatchObject({
      triggerCommentId: "88",
      triggerCommentBody: "@Zero please handle this",
    });
  });

  it("replaces GitHub issue comment file HTML with URL file blocks in the prompt", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [],
    });
    const fileUrl =
      "https://github.com/user-attachments/assets/4a354666-2014-433a-82c3-dc6941d6f0ec";

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture, {
        commentBody: `@${GITHUB_APP_SLUG}[bot] please inspect\n\n<img width="480" height="480" alt="Image" src="${fileUrl}">`,
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toContain("please inspect");
    expect(runs[0]?.prompt).toContain("[GitHub file]");
    expect(runs[0]?.prompt).toContain(`[URL] ${fileUrl}`);
    expect(runs[0]?.prompt).not.toContain("[ID]");
    expect(runs[0]?.prompt).not.toContain("[FILENAME]");
    expect(runs[0]?.prompt).not.toContain(
      `https://cdn.vm7.io/artifacts/${fixture.userId}/`,
    );
    expect(runs[0]?.prompt).not.toContain("<img");
    expect(runs[0]?.prompt).not.toContain("src=");
  });

  it("continues the same GitHub issue session for bot mention comments", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [],
    });
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
      throw new Error("agent session insert returned no row");
    }
    await db.insert(githubIssueSessions).values({
      userId: fixture.userId,
      installationId: fixture.installationDbId,
      repo: "vm0-ai/vm0",
      issueNumber: 42,
      agentSessionId: session.id,
      lastCommentId: "12",
    });

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture, {
        commentId: 78,
        commentBody: `@${GITHUB_APP_SLUG} continue this session`,
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    const runs = await selectGitHubRuns(fixture);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe(session.id);
    expect(runs[0]?.prompt).toBe("continue this session");

    const callbacks = await selectGitHubCallbacks(runs[0]?.id ?? "");
    expect(callbacks[0]?.payload).toMatchObject({
      existingSessionId: session.id,
      triggerCommentId: "78",
    });
  });

  it("replies to unconnected GitHub bot mentions with a connect link", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();
    mockGitHubAppCredentials();
    setupGitHubApiMocks({
      installationId: fixture.remoteInstallationId,
      comments: [],
    });
    const capturedComments: CapturedGitHubIssueComment[] = [];
    server.use(
      http.post(
        "https://api.github.com/repos/:owner/:repo/issues/:issueNumber/comments",
        async ({ request }) => {
          const body = (await request.json()) as { readonly body: string };
          capturedComments.push({ body: body.body });
          return HttpResponse.json({ id: 9876 });
        },
      ),
    );
    const unlinkedGithubUserId = remoteGitHubId();

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture, {
        senderId: unlinkedGithubUserId,
        senderLogin: "unlinked-user",
        commentBody: `@${GITHUB_APP_SLUG}[bot] please help`,
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(capturedComments).toHaveLength(1);
    const body = capturedComments[0]?.body ?? "";
    expect(body).toContain("connect your GitHub account first");
    const connectUrlText = body.match(/\[Connect GitHub\]\(([^)]+)\)/)?.[1];
    expect(connectUrlText).toBeDefined();
    const connectUrl = new URL(connectUrlText!);
    expect(connectUrl.origin).toBe("http://localhost:3002");
    expect(connectUrl.pathname).toBe("/github/connect");
    expect(connectUrl.searchParams.get("installation")).toBe(
      fixture.remoteInstallationId,
    );
    expect(connectUrl.searchParams.get("ghUser")).toBe(unlinkedGithubUserId);
    expect(connectUrl.searchParams.get("ghLogin")).toBe("unlinked-user");
    expect(connectUrl.searchParams.get("ts")).toMatch(/^\d+$/);
    expect(connectUrl.searchParams.get("sig")).toMatch(/^[a-f0-9]{64}$/);
    await expect(selectGitHubRuns(fixture)).resolves.toHaveLength(0);
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

  it("ignores label triggers for unbound GitHub installations", async () => {
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

  it("ignores bot mentions for unbound GitHub installations", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "issue_comment",
      payload: buildGitHubIssueCommentPayload(fixture, {
        installationId: remoteGitHubId(),
        commentBody: `@${GITHUB_APP_SLUG}[bot] please help`,
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

  it("ignores installation created events without activating pending records", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const db = store.set(writeDb$);
    const targetId = remoteGitHubId();
    const installationId = remoteGitHubId();
    await db.insert(githubInstallations).values({
      status: "pending",
      orgId: fixture.orgId,
      targetId,
      targetType: "Organization",
      targetName: "pending-org",
      defaultComposeId: fixture.composeId,
    });

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
      status: "pending",
      installationId: null,
      encryptedAccessToken: null,
      targetName: "pending-org",
      adminGithubUserId: null,
    });
  });

  it("ignores installation created events without a local record", async () => {
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

  it("cleans up installations after deleted installation events", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "installation",
      payload: buildGitHubInstallationPayload({
        action: "deleted",
        installationId: fixture.remoteInstallationId,
        targetId: remoteGitHubId(),
      }),
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const installations = await db
      .select({ id: githubInstallations.id })
      .from(githubInstallations)
      .where(eq(githubInstallations.id, fixture.installationDbId));
    expect(installations).toHaveLength(0);

    const links = await db
      .select({ id: githubUserLinks.id })
      .from(githubUserLinks)
      .where(eq(githubUserLinks.installationId, fixture.installationDbId));
    expect(links).toHaveLength(0);

    const listeners = await db
      .select({ id: githubLabelListeners.id })
      .from(githubLabelListeners)
      .where(eq(githubLabelListeners.installationId, fixture.installationDbId));
    expect(listeners).toHaveLength(0);
  });

  it("ignores unhandled installation events", async () => {
    mockGitHubWebhookEnv();

    const response = await postGitHubWebhook({
      event: "installation",
      payload: buildGitHubInstallationPayload({
        action: "suspend",
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
      path: STRIPE_WEBHOOK_PATH,
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "Stripe billing is not configured",
    });
  });

  it("returns 401 when stripe-signature header is missing", async () => {
    mockStripeWebhookEnv();

    const response = await postRaw({
      path: STRIPE_WEBHOOK_PATH,
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: "Missing stripe-signature header",
    });
  });

  it("rejects invalid Stripe signatures", async () => {
    mockStripeWebhookEnv();
    context.mocks.stripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const response = await postRaw({
      path: STRIPE_WEBHOOK_PATH,
      body: "{}",
      headers: { "stripe-signature": "bad" },
    });

    expect(response.status).toBe(401);
    expect(response.body).toStrictEqual({
      error: "Invalid webhook signature",
    });
  });

  it("returns 200 for unhandled event types without processing", async () => {
    mockStripeWebhookEnv();
    const body = JSON.stringify({ type: "payment_intent.created" });

    const response = await postStripeWebhookEvent({
      type: "payment_intent.created",
      dataObject: {},
      body,
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(context.mocks.stripe.webhooks.constructEvent).toHaveBeenCalledWith(
      body,
      "valid",
      STRIPE_WEBHOOK_SECRET,
    );
  });

  it("ignores preview Stripe invoices for a different job ref", async () => {
    mockStripeWebhookEnv();
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-123");

    const response = await postStripeWebhookEvent({
      type: "invoice.paid",
      dataObject: {
        id: stripeId("inv"),
        customer: stripeId("cus"),
        metadata: {},
        lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
        parent: {
          subscription_details: {
            subscription: stripeId("sub"),
            metadata: {
              vm0_environment: "preview",
              job_ref: "pr-456",
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(context.mocks.stripe.customers.retrieve).not.toHaveBeenCalled();
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("ignores preview Stripe checkout sessions for a different job ref", async () => {
    mockStripeWebhookEnv();
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-123");

    const response = await postStripeWebhookEvent({
      type: "checkout.session.completed",
      dataObject: {
        id: stripeId("cs"),
        subscription: stripeId("sub"),
        customer: stripeId("cus"),
        metadata: {
          vm0_environment: "preview",
          job_ref: "pr-456",
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(context.mocks.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it("ignores preview Stripe subscriptions for a different job ref", async () => {
    mockStripeWebhookEnv();
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-123");

    const response = await postStripeWebhookEvent({
      type: "customer.subscription.created",
      dataObject: {
        id: stripeId("sub"),
        customer: stripeId("cus"),
        status: "active",
        metadata: {
          vm0_environment: "preview",
          job_ref: "pr-456",
        },
        cancel_at_period_end: false,
        items: {
          data: [{ price: { id: STRIPE_PRICE_PRO } }],
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");
    expect(context.mocks.stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("processes preview Stripe invoices with the current subscription job ref", async () => {
    const fixture = await trackStripe(
      store.set(seedStripeFixture$, undefined, context.signal),
    );
    mockStripeWebhookEnv();
    mockEnv("ENV", "preview");
    mockOptionalEnv("VM0_PREVIEW_JOB_REF", "pr-123");
    const subId = stripeId("sub");
    const invId = stripeId("inv");
    const periodEnd = 1_800_000_000;
    context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
      id: subId,
      status: "active",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
    });

    const response = await postStripeWebhookEvent({
      type: "invoice.paid",
      dataObject: {
        id: invId,
        customer: fixture.stripeCustomerId,
        metadata: {},
        lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
        parent: {
          subscription_details: {
            subscription: subId,
            metadata: {
              vm0_environment: "preview",
              job_ref: "pr-123",
            },
          },
        },
      },
    });

    expect(response.status).toBe(200);
    const billing = await selectStripeBilling(fixture);
    expect(billing.credits).toBe(20_000);
    expect(billing.tier).toBe("pro");
    expect(billing.stripeSubscriptionId).toBe(subId);
    expect(billing.lastProcessedInvoiceId).toBe(invId);
  });

  describe("checkout.session.completed", () => {
    it("records subscription checkout without granting invoice-backed entitlement", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      await updateStripeOrg(fixture, { onboardingPaymentPending: true });
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: {
          data: [
            {
              price: { id: STRIPE_PRICE_PRO },
              current_period_end: periodEnd,
            },
          ],
        },
      });

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: stripeId("cs"),
          subscription: subId,
          customer: fixture.stripeCustomerId,
          metadata: null,
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBe(subId);
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.currentPeriodEnd).toBeNull();
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.onboardingPaymentPending).toBeTruthy();
    });

    it("is idempotent when subscription is already stored", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        tier: "pro",
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: stripeId("cs"),
          subscription: subId,
          customer: fixture.stripeCustomerId,
          metadata: null,
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro");
      expect(billing.stripeSubscriptionId).toBe(subId);
    });

    it("does not replace a higher current tier with a lower checkout", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const teamSubId = stripeId("sub");
      const proSubId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: teamSubId,
        subscriptionStatus: "active",
        tier: "team",
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: proSubId,
        status: "active",
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: stripeId("cs"),
          subscription: proSubId,
          customer: fixture.stripeCustomerId,
          metadata: null,
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("team");
      expect(billing.stripeSubscriptionId).toBe(teamSubId);
      expect(billing.subscriptionStatus).toBe("active");
    });

    it("does not grant one-time credits before checkout payment settles", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const sessionId = stripeId("cs");

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: sessionId,
          subscription: null,
          customer: fixture.stripeCustomerId,
          payment_status: "unpaid",
          metadata: {
            purpose: "one_time_purchase",
            orgId: fixture.orgId,
            campaignKey: "ZERO100",
          },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(creditsBefore);
      await expect(
        selectStripeCreditExpiresRecords(fixture),
      ).resolves.toHaveLength(0);
    });

    it("grants one-time credits on async payment success", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const sessionId = stripeId("cs");

      const response = await postStripeWebhookEvent({
        type: "checkout.session.async_payment_succeeded",
        dataObject: {
          id: sessionId,
          subscription: null,
          customer: fixture.stripeCustomerId,
          payment_status: "paid",
          metadata: {
            purpose: "one_time_purchase",
            orgId: fixture.orgId,
            campaignKey: "ZERO100",
          },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(
        creditsBefore + 100_000,
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "one_time_purchase",
        stripeInvoiceId: sessionId,
        amount: 100_000,
        remaining: 100_000,
      });
    });

    it("grants custom credit purchase credits from the checkout subtotal before discounts", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const sessionId = stripeId("cs");

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: sessionId,
          subscription: null,
          customer: fixture.stripeCustomerId,
          payment_status: "paid",
          amount_subtotal: 10_000,
          amount_total: 5000,
          metadata: {
            purpose: "credit_purchase",
            orgId: fixture.orgId,
            creditsAmountMode: "amount_subtotal",
          },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(
        creditsBefore + 100_000,
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "auto_recharge",
        stripeInvoiceId: sessionId,
        amount: 100_000,
        remaining: 100_000,
      });
    });

    it("keeps processing older custom credit checkout sessions from the checkout total", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const sessionId = stripeId("cs");

      const response = await postStripeWebhookEvent({
        type: "checkout.session.completed",
        dataObject: {
          id: sessionId,
          subscription: null,
          customer: fixture.stripeCustomerId,
          payment_status: "paid",
          amount_total: 10_000,
          metadata: {
            purpose: "credit_purchase",
            orgId: fixture.orgId,
            creditsAmountMode: "amount_total",
          },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(
        creditsBefore + 100_000,
      );
    });
  });

  describe("customer.subscription.created", () => {
    it("binds a dashboard-created Pro subscription to the org by Stripe customer", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, { onboardingPaymentPending: true });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.created",
        dataObject: {
          id: subId,
          customer: fixture.stripeCustomerId,
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBe(subId);
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.currentPeriodEnd).toBeNull();
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.onboardingPaymentPending).toBeTruthy();
    });

    it("records an incomplete subscription without granting paid tier", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, { onboardingPaymentPending: true });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.created",
        dataObject: {
          id: subId,
          customer: fixture.stripeCustomerId,
          status: "incomplete",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: 1_800_000_000,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBe(subId);
      expect(billing.subscriptionStatus).toBe("incomplete");
      expect(billing.currentPeriodEnd).toBeNull();
      expect(billing.onboardingPaymentPending).toBeTruthy();
    });

    it("does not bind a subscription for an unknown Stripe customer", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const customerId = stripeId("cus");
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: {},
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.created",
        dataObject: {
          id: stripeId("sub"),
          customer: customerId,
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [{ price: { id: STRIPE_PRICE_PRO } }],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBeNull();
      expect(billing.subscriptionStatus).toBeNull();
    });

    it("binds a dashboard-created customer to the org from Stripe metadata", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const customerId = stripeId("cus");
      const subId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, { stripeCustomerId: null });
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: fixture.orgId },
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.created",
        dataObject: {
          id: subId,
          customer: customerId,
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.stripeCustomerId).toBe(customerId);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBe(subId);
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.currentPeriodEnd).toBeNull();
    });

    it("does not rebind metadata to an org with a different Stripe customer", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const customerId = stripeId("cus");
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: customerId,
        metadata: { orgId: fixture.orgId },
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.created",
        dataObject: {
          id: stripeId("sub"),
          customer: customerId,
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [{ price: { id: STRIPE_PRICE_PRO } }],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.stripeCustomerId).toBe(fixture.stripeCustomerId);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.stripeSubscriptionId).toBeNull();
      expect(billing.subscriptionStatus).toBeNull();
    });
  });

  describe("invoice.paid", () => {
    it("grants 20k credits for pro tier", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        onboardingPaymentPending: true,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.credits - creditsBefore).toBe(20_000);
      expect(billing.tier).toBe("pro");
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.onboardingPaymentPending).toBeFalsy();
      expect(billing.lastProcessedInvoiceId).toBe(invId);
      expect(billing.currentPeriodEnd).toStrictEqual(
        new Date(periodEnd * 1000),
      );
    });

    it("binds the Stripe customer and grants credits when invoice.paid arrives first", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeCustomerId: null,
        onboardingPaymentPending: true,
      });
      context.mocks.stripe.customers.retrieve.mockResolvedValue({
        id: fixture.stripeCustomerId,
        metadata: { orgId: fixture.orgId },
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.stripeCustomerId).toBe(fixture.stripeCustomerId);
      expect(billing.stripeSubscriptionId).toBe(subId);
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.tier).toBe("pro");
      expect(billing.onboardingPaymentPending).toBeFalsy();
      expect(billing.credits).toBe(20_000);
      expect(billing.lastProcessedInvoiceId).toBe(invId);
      expect(billing.currentPeriodEnd).toStrictEqual(
        new Date(periodEnd * 1000),
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "subscription_renewal",
        stripeInvoiceId: invId,
        amount: 20_000,
        remaining: 20_000,
      });
    });

    it("grants 120k credits for team tier", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits - creditsBefore).toBe(
        120_000,
      );
      expect(context.mocks.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    });

    it("drains queued runs to the new team capacity after a paid invoice", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const db = store.set(writeDb$);
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      const now = nowDate();
      await updateStripeOrg(fixture, {
        credits: 100_000,
        tier: "free",
      });
      const compose = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await seedStripeRun(fixture, {
        composeId: compose.composeId,
        status: "running",
        startedAt: now,
      });
      const firstQueuedRunId = await seedStripeQueuedRun(fixture, {
        composeId: compose.composeId,
        createdAt: new Date(now.getTime() + 1000),
      });
      const secondQueuedRunId = await seedStripeQueuedRun(fixture, {
        composeId: compose.composeId,
        createdAt: new Date(now.getTime() + 2000),
      });
      const queuedRunIds = [firstQueuedRunId, secondQueuedRunId];
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).tier).toBe("team");
      const promotedRuns = await db
        .select({ id: agentRuns.id, status: agentRuns.status })
        .from(agentRuns)
        .where(inArray(agentRuns.id, queuedRunIds));
      const promotedStatuses = new Map(
        promotedRuns.map((run) => {
          return [run.id, run.status];
        }),
      );
      expect(promotedStatuses.get(firstQueuedRunId)).toBe("pending");
      expect(promotedStatuses.get(secondQueuedRunId)).toBe("pending");

      const queueRows = await db
        .select({ runId: agentRunQueue.runId })
        .from(agentRunQueue)
        .where(inArray(agentRunQueue.runId, queuedRunIds));
      expect(queueRows).toHaveLength(0);

      const runnerJobs = await db
        .select({ runId: runnerJobQueue.runId })
        .from(runnerJobQueue)
        .where(inArray(runnerJobQueue.runId, queuedRunIds));
      expect(runnerJobs).toHaveLength(2);

      const duplicateQueuedRunId = await seedStripeQueuedRun(fixture, {
        composeId: compose.composeId,
        createdAt: new Date(now.getTime() + 3000),
      });
      const duplicateResponse = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });
      expect(duplicateResponse.status).toBe(200);
      const [duplicateRun] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, duplicateQueuedRunId))
        .limit(1);
      expect(duplicateRun?.status).toBe("pending");
    });

    it("cancels the replaced Pro subscription after the Team invoice is paid", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const proSubId = stripeId("sub");
      const teamSubId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: proSubId,
        subscriptionStatus: "active",
        tier: "pro",
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: teamSubId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: proSubId,
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: teamSubId } },
        },
      });

      expect(response.status).toBe(200);
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        proSubId,
        { invoice_now: false, prorate: false },
      );
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("team");
      expect(billing.stripeSubscriptionId).toBe(teamSubId);
      expect(billing.subscriptionStatus).toBe("active");
      expect(billing.lastProcessedInvoiceId).toBe(invId);
    });

    it("cancels an old Pro subscription when subscription.created already stored the Team subscription", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const proSubId = stripeId("sub");
      const teamSubId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: teamSubId,
        subscriptionStatus: "active",
        tier: "pro",
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: teamSubId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [
          {
            id: teamSubId,
            status: "active",
            metadata: { orgId: fixture.orgId },
            items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
          },
          {
            id: proSubId,
            status: "active",
            metadata: { orgId: fixture.orgId },
            items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
          },
        ],
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: proSubId,
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: teamSubId } },
        },
      });

      expect(response.status).toBe(200);
      expect(context.mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
        customer: fixture.stripeCustomerId,
        status: "all",
        limit: 100,
      });
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        proSubId,
        { invoice_now: false, prorate: false },
      );
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("team");
      expect(billing.stripeSubscriptionId).toBe(teamSubId);
      expect(billing.lastProcessedInvoiceId).toBe(invId);
    });

    it("cleans up a lingering Pro subscription when a processed Team invoice is redelivered", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const proSubId = stripeId("sub");
      const teamSubId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: teamSubId,
        subscriptionStatus: "active",
        tier: "team",
        lastProcessedInvoiceId: invId,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: teamSubId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });
      context.mocks.stripe.subscriptions.list.mockResolvedValue({
        data: [
          {
            id: proSubId,
            status: "active",
            metadata: { orgId: fixture.orgId },
            items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
          },
        ],
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: proSubId,
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: teamSubId } },
        },
      });

      expect(response.status).toBe(200);
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        proSubId,
        { invoice_now: false, prorate: false },
      );
      const billing = await selectStripeBilling(fixture);
      expect(billing.credits).toBe(creditsBefore);
      expect(billing.lastProcessedInvoiceId).toBe(invId);
      await expect(
        selectStripeCreditExpiresRecords(fixture),
      ).resolves.toHaveLength(0);
    });

    it("cancels the replaced Pro trial subscription after the Team invoice is paid", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const trialSubId = stripeId("sub");
      const teamSubId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: trialSubId,
        subscriptionStatus: "trialing",
        tier: "pro-suspend",
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: teamSubId,
        status: "active",
        cancel_at_period_end: false,
        items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
      });
      context.mocks.stripe.subscriptions.cancel.mockResolvedValue({
        id: trialSubId,
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: teamSubId } },
        },
      });

      expect(response.status).toBe(200);
      expect(context.mocks.stripe.subscriptions.cancel).toHaveBeenCalledWith(
        trialSubId,
        { invoice_now: false, prorate: false },
      );
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("team");
      expect(billing.stripeSubscriptionId).toBe(teamSubId);
    });

    it("skips lower subscription invoices when a higher subscription is current", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const teamSubId = stripeId("sub");
      const proSubId = stripeId("sub");
      const invId = stripeId("inv");
      const currentPeriodEnd = new Date("2026-04-26T07:24:12Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: teamSubId,
        tier: "team",
        currentPeriodEnd,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: proSubId,
        status: "active",
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
          parent: { subscription_details: { subscription: proSubId } },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.credits).toBe(creditsBefore);
      expect(billing.tier).toBe("team");
      expect(billing.stripeSubscriptionId).toBe(teamSubId);
      expect(billing.lastProcessedInvoiceId).toBeNull();
      expect(billing.currentPeriodEnd).toStrictEqual(currentPeriodEnd);
      await expect(
        selectStripeCreditExpiresRecords(fixture),
      ).resolves.toStrictEqual([]);
    });

    it("adds renewal credits to an existing balance", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        credits: 5000,
        stripeSubscriptionId: subId,
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(
        creditsBefore + 20_000,
      );
    });

    it("skips duplicate invoice IDs already stored on the org", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        lastProcessedInvoiceId: invId,
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits).toBe(creditsBefore);
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
    });

    it("skips invoices without subscription", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: null,
          parent: null,
        },
      });

      expect(response.status).toBe(200);
      expect(
        context.mocks.stripe.subscriptions.retrieve,
      ).not.toHaveBeenCalled();
    });

    it("grants credits for auto-recharge invoice metadata", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      await updateStripeOrg(fixture, { autoRechargePendingAt: nowDate() });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: {
            type: "auto_recharge",
            orgId: fixture.orgId,
            creditsAmount: "5000",
          },
          parent: null,
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.credits - creditsBefore).toBe(5000);
      expect(billing.autoRechargePendingAt).toBeNull();
    });
  });

  describe("customer.subscription.updated", () => {
    it("syncs failed payment status without restoring paid entitlement from price", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "past_due",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.subscriptionStatus).toBe("past_due");
      expect(billing.tier).toBe("pro");
    });

    it("does not downgrade tier from a subscription price change before invoice payment", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "team",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("team");
      expect(billing.subscriptionStatus).toBe("active");
    });

    it("does not update tier from legacy price ID before invoice payment", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_TEAM_LEGACY } }] },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).tier).toBe("pro");
    });

    it("syncs cancelAtPeriodEnd true from subscription.updated", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: true,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        },
      });

      expect(response.status).toBe(200);
      expect(
        (await selectStripeBilling(fixture)).cancelAtPeriodEnd,
      ).toBeTruthy();
    });

    it("syncs scheduled cancellation when Stripe only sends cancel_at", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const cancelAt = 1_800_000_000;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at: cancelAt,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: cancelAt,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.cancelAtPeriodEnd).toBeTruthy();
      expect(billing.currentPeriodEnd).toStrictEqual(new Date(cancelAt * 1000));
    });

    it("clears cancelAtPeriodEnd when subscription is uncancelled", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        },
      });

      expect(response.status).toBe(200);
      expect(
        (await selectStripeBilling(fixture)).cancelAtPeriodEnd,
      ).toBeFalsy();
    });

    it("clears pending billing changes when subscription cancellation is restored in Stripe", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const changeAt = new Date("2026-07-04T00:00:00.000Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        pendingSubscriptionTargetTier: "pro-suspend",
        pendingSubscriptionChangeAt: changeAt,
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        },
        previousAttributes: { cancel_at_period_end: true },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.pendingSubscriptionScheduleId).toBeNull();
      expect(billing.pendingSubscriptionTargetTier).toBeNull();
      expect(billing.pendingSubscriptionChangeAt).toBeNull();
    });

    it("does not clear pending schedules on unrelated active subscription updates", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const scheduleId = stripeId("sched");
      const changeAt = new Date("2026-07-04T00:00:00.000Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
        pendingSubscriptionScheduleId: scheduleId,
        pendingSubscriptionTargetTier: "pro",
        pendingSubscriptionChangeAt: changeAt,
        tier: "team",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_TEAM } }] },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.pendingSubscriptionScheduleId).toBe(scheduleId);
      expect(billing.pendingSubscriptionTargetTier).toBe("pro");
      expect(billing.pendingSubscriptionChangeAt).toStrictEqual(changeAt);
    });

    it("clears pending billing changes when subscription schedule is released in Stripe", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const scheduleId = stripeId("sched");
      const changeAt = new Date("2026-07-04T00:00:00.000Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        pendingSubscriptionScheduleId: scheduleId,
        pendingSubscriptionTargetTier: "pro-suspend",
        pendingSubscriptionChangeAt: changeAt,
        tier: "team",
      });

      const response = await postStripeWebhookEvent({
        type: "subscription_schedule.released",
        dataObject: {
          id: scheduleId,
          status: "released",
          released_subscription: subId,
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.pendingSubscriptionScheduleId).toBeNull();
      expect(billing.pendingSubscriptionTargetTier).toBeNull();
      expect(billing.pendingSubscriptionChangeAt).toBeNull();
    });

    it("does not refresh current period end for active subscriptions before invoice payment", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const periodEnd = 1_800_000_000;
      const paidThrough = new Date("2026-04-26T07:24:12Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        tier: "pro",
        currentPeriodEnd: paidThrough,
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "active",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: periodEnd,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      expect(
        (await selectStripeBilling(fixture)).currentPeriodEnd,
      ).toStrictEqual(paidThrough);
    });

    it("does not extend trial period or credit expiry from subscription updates", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const existingPeriodEnd = new Date("2026-01-01T00:00:00.000Z");
      const existingExpiresAt = new Date("2026-01-02T00:00:00.000Z");
      const extendedPeriodEnd = 1_900_000_000;
      const extendedTrialEnd = 1_900_086_400;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "trialing",
        tier: "pro",
        currentPeriodEnd: existingPeriodEnd,
      });
      await insertStripeCreditExpiresRecord(fixture, {
        stripeInvoiceId: stripeId("inv_trial"),
        amount: 20_000,
        remaining: 15_000,
        expiresAt: existingExpiresAt,
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "trialing",
          trial_end: extendedTrialEnd,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: extendedPeriodEnd,
              },
            ],
          },
        },
        previousAttributes: { trial_end: 1_800_000_000 },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(billing.currentPeriodEnd).toStrictEqual(existingPeriodEnd);
      expect(records).toHaveLength(1);
      expect(records[0]?.expiresAt).toStrictEqual(existingExpiresAt);
    });

    it("clamps trial period and credit expiry when subscription update shortens trial", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const shortenedTrialEnd = 1_800_000_000;
      const previousTrialEnd = 1_900_000_000;
      const existingPeriodEnd = new Date(previousTrialEnd * 1000);
      const existingExpiresAt = new Date(previousTrialEnd * 1000);
      await updateStripeOrg(fixture, {
        credits: 20_000,
        stripeSubscriptionId: subId,
        subscriptionStatus: "trialing",
        tier: "pro",
        currentPeriodEnd: existingPeriodEnd,
      });
      await insertStripeCreditExpiresRecord(fixture, {
        stripeInvoiceId: stripeId("inv_trial"),
        amount: 20_000,
        remaining: 15_000,
        expiresAt: existingExpiresAt,
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "trialing",
          trial_end: shortenedTrialEnd,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: shortenedTrialEnd,
              },
            ],
          },
        },
        previousAttributes: { trial_end: previousTrialEnd },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(billing.credits).toBe(20_000);
      expect(billing.tier).toBe("pro");
      expect(billing.subscriptionStatus).toBe("trialing");
      expect(billing.currentPeriodEnd).toStrictEqual(
        new Date(shortenedTrialEnd * 1000),
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        amount: 20_000,
        remaining: 15_000,
      });
      expect(records[0]?.expiresAt).toStrictEqual(
        new Date(shortenedTrialEnd * 1000),
      );
    });

    it("does not extend paid-through from a failed payment update", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const paidThrough = new Date("2099-01-01T00:00:00.000Z");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        currentPeriodEnd: paidThrough,
        tier: "pro",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.updated",
        dataObject: {
          id: subId,
          status: "past_due",
          cancel_at_period_end: false,
          items: {
            data: [
              {
                price: { id: STRIPE_PRICE_PRO },
                current_period_end: 1_800_000_000,
              },
            ],
          },
        },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro");
      expect(billing.subscriptionStatus).toBe("past_due");
      expect(billing.currentPeriodEnd).toStrictEqual(paidThrough);
    });
  });

  describe("invoice.paid credit expiry", () => {
    it("creates Pro expires record after the subscription period grace", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "active",
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        amount: 20_000,
        remaining: 20_000,
        stripeInvoiceId: invId,
      });
      const expectedExpiresAt = new Date(periodEnd * 1000);
      expectedExpiresAt.setMonth(expectedExpiresAt.getMonth() + 1);
      expect(records[0]?.expiresAt).toStrictEqual(expectedExpiresAt);
    });

    it("creates trialing Pro expires record at the Stripe trial period end", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      const periodEnd = 1_800_000_000;
      const trialEnd = 1_800_086_400;
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        status: "trialing",
        trial_end: trialEnd,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(periodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        amount: 20_000,
        remaining: 20_000,
        stripeInvoiceId: invId,
      });
      expect(records[0]?.expiresAt).toStrictEqual(new Date(trialEnd * 1000));
    });

    it("refreshes trial expiry from later trial invoices without granting duplicate credits", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const firstInvId = stripeId("inv");
      const secondInvId = stripeId("inv");
      const firstPeriodEnd = 1_800_000_000;
      const firstTrialEnd = 1_800_086_400;
      const extendedPeriodEnd = 1_900_000_000;
      const extendedTrialEnd = 1_900_086_400;
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        onboardingPaymentPending: true,
      });
      context.mocks.stripe.subscriptions.retrieve
        .mockResolvedValueOnce({
          id: subId,
          status: "trialing",
          trial_end: firstTrialEnd,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        })
        .mockResolvedValueOnce({
          id: subId,
          status: "trialing",
          trial_end: extendedTrialEnd,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
        });

      const firstResponse = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: firstInvId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(firstPeriodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });
      const secondResponse = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: secondInvId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(extendedPeriodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(billing.credits).toBe(20_000);
      expect(billing.tier).toBe("pro");
      expect(billing.subscriptionStatus).toBe("trialing");
      expect(billing.lastProcessedInvoiceId).toBe(secondInvId);
      expect(billing.currentPeriodEnd).toStrictEqual(
        new Date(extendedPeriodEnd * 1000),
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        amount: 20_000,
        remaining: 20_000,
        stripeInvoiceId: firstInvId,
      });
      expect(records[0]?.expiresAt).toStrictEqual(
        new Date(extendedTrialEnd * 1000),
      );
    });

    it("expires old credits before granting new ones", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      await updateStripeOrg(fixture, {
        credits: 100_000,
        stripeSubscriptionId: subId,
      });
      await insertStripeCreditExpiresRecord(fixture, {
        stripeInvoiceId: stripeId("inv_old"),
        amount: 5000,
        remaining: 3000,
        expiresAt: new Date("2025-01-01T00:00:00.000Z"),
      });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits - creditsBefore).toBe(
        17_000,
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      const oldRecord = records.find((record) => {
        return record.stripeInvoiceId !== invId;
      });
      expect(oldRecord?.remaining).toBe(0);
    });

    it("concurrent duplicate invoice.paid grants credits only once", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const payload = {
        id: invId,
        customer: fixture.stripeCustomerId,
        metadata: null,
        lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
        parent: { subscription_details: { subscription: subId } },
      };

      const [first, second] = await Promise.all([
        postStripeWebhookEvent({ type: "invoice.paid", dataObject: payload }),
        postStripeWebhookEvent({ type: "invoice.paid", dataObject: payload }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits - creditsBefore).toBe(
        20_000,
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(
        records.filter((record) => {
          return record.stripeInvoiceId === invId;
        }),
      ).toHaveLength(1);
    });

    it("duplicate invoice.paid is idempotent for expires records", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const payload = {
        id: invId,
        customer: fixture.stripeCustomerId,
        metadata: null,
        lines: invoiceLinesWithSubscriptionPeriod(1_800_000_000),
        parent: { subscription_details: { subscription: subId } },
      };

      await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: payload,
      });
      await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: payload,
      });

      await expect(
        selectStripeCreditExpiresRecords(fixture),
      ).resolves.toHaveLength(1);
    });

    it("rolls back transaction when no subscription line item has period.end", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: stripeId("inv"),
          customer: fixture.stripeCustomerId,
          metadata: null,
          lines: { data: [] },
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(500);
      expect(response.body).toStrictEqual({ error: "Internal server error" });
      expect((await selectStripeBilling(fixture)).credits).toBe(creditsBefore);
      await expect(
        selectStripeCreditExpiresRecords(fixture),
      ).resolves.toHaveLength(0);
    });

    it("writes subscription line period.end to currentPeriodEnd instead of invoice.period_end", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      const invId = stripeId("inv");
      await updateStripeOrg(fixture, { stripeSubscriptionId: subId });
      context.mocks.stripe.subscriptions.retrieve.mockResolvedValue({
        id: subId,
        items: { data: [{ price: { id: STRIPE_PRICE_PRO } }] },
      });
      const invoiceAccrualEnd = Math.floor(
        new Date("2026-03-26T07:24:12Z").getTime() / 1000,
      );
      const subscriptionPeriodEnd = Math.floor(
        new Date("2026-04-26T07:24:12Z").getTime() / 1000,
      );

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          period_end: invoiceAccrualEnd,
          metadata: null,
          lines: invoiceLinesWithSubscriptionPeriod(subscriptionPeriodEnd),
          parent: { subscription_details: { subscription: subId } },
        },
      });

      expect(response.status).toBe(200);
      expect(
        (await selectStripeBilling(fixture)).currentPeriodEnd,
      ).toStrictEqual(new Date("2026-04-26T07:24:12Z"));
    });

    it("auto-recharge writes a sentinel expires record with far-future expiresAt", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      await updateStripeOrg(fixture, { autoRechargePendingAt: nowDate() });
      const invId = stripeId("inv");

      const response = await postStripeWebhookEvent({
        type: "invoice.paid",
        dataObject: {
          id: invId,
          customer: fixture.stripeCustomerId,
          metadata: {
            type: "auto_recharge",
            orgId: fixture.orgId,
            creditsAmount: "5000",
          },
          parent: null,
        },
      });

      expect(response.status).toBe(200);
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "auto_recharge",
        stripeInvoiceId: invId,
        amount: 5000,
      });
      expect(records[0]?.expiresAt.getUTCFullYear()).toBeGreaterThanOrEqual(
        2999,
      );
    });

    it("concurrent duplicate auto-recharge grants credits only once", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      await updateStripeOrg(fixture, { autoRechargePendingAt: nowDate() });
      const creditsBefore = (await selectStripeBilling(fixture)).credits;
      const invId = stripeId("inv");
      const payload = {
        id: invId,
        customer: fixture.stripeCustomerId,
        metadata: {
          type: "auto_recharge",
          orgId: fixture.orgId,
          creditsAmount: "5000",
        },
        parent: null,
      };

      const [first, second] = await Promise.all([
        postStripeWebhookEvent({ type: "invoice.paid", dataObject: payload }),
        postStripeWebhookEvent({ type: "invoice.paid", dataObject: payload }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await selectStripeBilling(fixture)).credits - creditsBefore).toBe(
        5000,
      );
      const records = await selectStripeCreditExpiresRecords(fixture);
      expect(
        records.filter((record) => {
          return record.stripeInvoiceId === invId;
        }),
      ).toHaveLength(1);
    });
  });

  describe("customer.subscription.deleted", () => {
    it("downgrades to pro-suspend and clears subscription", async () => {
      const fixture = await trackStripe(
        store.set(seedStripeFixture$, undefined, context.signal),
      );
      mockStripeWebhookEnv();
      const subId = stripeId("sub");
      await updateStripeOrg(fixture, {
        stripeSubscriptionId: subId,
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date("2026-07-04T03:55:51Z"),
        tier: "team",
      });

      const response = await postStripeWebhookEvent({
        type: "customer.subscription.deleted",
        dataObject: { id: subId },
      });

      expect(response.status).toBe(200);
      const billing = await selectStripeBilling(fixture);
      expect(billing.tier).toBe("pro-suspend");
      expect(billing.subscriptionStatus).toBe("canceled");
      expect(billing.stripeSubscriptionId).toBeNull();
      expect(billing.cancelAtPeriodEnd).toBeFalsy();
      expect(billing.currentPeriodEnd).toBeNull();
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
    await seedClerkOauthDeviceAuthSession(fixture);
    await seedClerkModelProviderAuthSession(fixture);
    const agent = await seedClerkAgent(fixture, fixture.userId);
    await store.set(writeDb$).insert(userPermissionGrants).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentId: agent.agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });
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
    const deviceSessionRows = await db
      .select({ id: connectorOauthDeviceAuthorizationSessions.id })
      .from(connectorOauthDeviceAuthorizationSessions)
      .where(
        eq(connectorOauthDeviceAuthorizationSessions.orgId, fixture.orgId),
      );
    const modelProviderAuthSessionRows = await db
      .select({ id: modelProviderAuthSessions.id })
      .from(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.orgId, fixture.orgId));
    const grantRows = await db
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(eq(userPermissionGrants.orgId, fixture.orgId));
    expect(cacheRows).toHaveLength(0);
    expect(metadataRows).toHaveLength(0);
    expect(membershipRows).toHaveLength(0);
    expect(deviceSessionRows).toHaveLength(0);
    expect(modelProviderAuthSessionRows).toHaveLength(0);
    expect(grantRows).toHaveLength(0);
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
    await seedClerkOauthDeviceAuthSession(fixture);
    await seedClerkModelProviderAuthSession(fixture);
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
    const deviceSessionRows = await db
      .select({ id: connectorOauthDeviceAuthorizationSessions.id })
      .from(connectorOauthDeviceAuthorizationSessions)
      .where(
        eq(connectorOauthDeviceAuthorizationSessions.userId, fixture.userId),
      );
    const modelProviderAuthSessionRows = await db
      .select({ id: modelProviderAuthSessions.id })
      .from(modelProviderAuthSessions)
      .where(eq(modelProviderAuthSessions.userId, fixture.userId));
    expect(cacheRows).toHaveLength(0);
    expect(userRows).toHaveLength(0);
    expect(orgRows).toHaveLength(1);
    expect(deviceSessionRows).toHaveLength(0);
    expect(modelProviderAuthSessionRows).toHaveLength(0);
  });

  it("removes deleted user permission grants without removing grants for other users", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const agent = await seedClerkAgent(fixture);
    const db = store.set(writeDb$);
    await db.insert(userPermissionGrants).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        agentId: agent.agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: SLACK_READ_PERMISSION,
        action: "allow",
      },
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        agentId: agent.agentId,
        connectorRef: SLACK_CONNECTOR,
        permission: SLACK_WRITE_PERMISSION,
        action: "deny",
      },
    ]);
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

    const deletedUserGrantRows = await db
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.agentId, agent.agentId),
          eq(userPermissionGrants.userId, fixture.userId),
        ),
      );
    const otherUserGrantRows = await db
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(
        and(
          eq(userPermissionGrants.agentId, agent.agentId),
          eq(userPermissionGrants.userId, otherUserId),
        ),
      );
    const agentRows = await db
      .select({ id: zeroAgents.id, owner: zeroAgents.owner })
      .from(zeroAgents)
      .where(eq(zeroAgents.id, agent.agentId));
    expect(deletedUserGrantRows).toHaveLength(0);
    expect(otherUserGrantRows).toHaveLength(1);
    expect(agentRows).toStrictEqual([
      { id: agent.agentId, owner: agent.ownerUserId },
    ]);
  });

  it("removes user permission grants through the agent delete cascade", async () => {
    const fixture = await trackClerk(
      store.set(seedClerkFixture$, undefined, context.signal),
    );
    const agent = await seedClerkAgent(fixture, fixture.userId);
    const db = store.set(writeDb$);
    await db.insert(userPermissionGrants).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      agentId: agent.agentId,
      connectorRef: SLACK_CONNECTOR,
      permission: SLACK_READ_PERMISSION,
      action: "allow",
    });

    await db.delete(zeroAgents).where(eq(zeroAgents.id, agent.agentId));

    const grantRows = await db
      .select({ id: userPermissionGrants.id })
      .from(userPermissionGrants)
      .where(eq(userPermissionGrants.agentId, agent.agentId));
    expect(grantRows).toHaveLength(0);
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
