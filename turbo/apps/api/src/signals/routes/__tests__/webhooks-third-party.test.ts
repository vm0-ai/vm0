import { createHmac, randomUUID } from "node:crypto";

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
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
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

interface AppResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

interface GitHubWebhookFixture extends UsageInsightFixture {
  readonly composeId: string;
  readonly installationDbId: string;
}

interface StripeFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface ClerkFixture {
  readonly orgId: string;
  readonly userId: string;
}

function signGithub(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
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
    await db
      .delete(githubUserLinks)
      .where(eq(githubUserLinks.installationId, fixture.installationDbId));
    signal.throwIfAborted();
    await db
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, fixture.installationDbId));
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
        installationId: "123456",
        status: "active",
        defaultComposeId: compose.id,
      })
      .returning({ id: githubInstallations.id });
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("installation insert returned no row");
    }

    await db.insert(githubUserLinks).values({
      githubUserId: "98765",
      installationId: installation.id,
      vm0UserId: fixture.userId,
    });
    signal.throwIfAborted();

    return {
      ...fixture,
      composeId: compose.id,
      installationDbId: installation.id,
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
      path: "/api/webhooks/github",
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("rejects invalid GitHub signatures", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", "github-secret");
    const response = await postRaw({
      path: "/api/webhooks/github",
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

  it("responds to GitHub ping", async () => {
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", "github-secret");
    const body = JSON.stringify({ zen: "testing" });

    const response = await postRaw({
      path: "/api/webhooks/github",
      body,
      headers: {
        "x-hub-signature-256": signGithub("github-secret", body),
        "x-github-event": "ping",
        "x-github-delivery": "delivery-1",
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ message: "pong" });
  });

  it("dispatches GitHub issue comments through API-native run creation", async () => {
    const fixture = await trackGitHub(
      store.set(seedGitHubWebhookFixture$, undefined, context.signal),
    );
    mockOptionalEnv("GITHUB_APP_WEBHOOK_SECRET", "github-secret");
    mockOptionalEnv("GITHUB_APP_SLUG", "vm0-agent");
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    context.mocks.s3.send.mockResolvedValue({});

    const body = JSON.stringify({
      action: "created",
      issue: {
        number: 7,
        title: "Investigate API route",
        body: "Move the route to apps/api",
        labels: [],
        user: { id: 123, login: "reporter", type: "User" },
      },
      comment: {
        id: 77,
        body: "@vm0-agent[bot] please handle this",
        user: { id: 98_765, login: "linked-user", type: "User" },
      },
      repository: { full_name: "vm0-ai/vm0" },
      installation: { id: 123_456 },
      sender: { id: 98_765, login: "linked-user", type: "User" },
    });

    const response = await postRaw({
      path: "/api/webhooks/github",
      body,
      headers: {
        "x-hub-signature-256": signGithub("github-secret", body),
        "x-github-event": "issue_comment",
        "x-github-delivery": "delivery-2",
      },
    });
    await clearAllDetached();

    expect(response.status).toBe(200);
    expect(response.body).toBe("OK");

    const db = store.set(writeDb$);
    const runs = await db
      .select({
        id: agentRuns.id,
        prompt: agentRuns.prompt,
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

    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt).toBe("@vm0-agent[bot] please handle this");
    expect(runs[0]?.triggerSource).toBe("github");

    const callbacks = await db
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, runs[0]?.id ?? ""));
    expect(callbacks).toHaveLength(1);
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
