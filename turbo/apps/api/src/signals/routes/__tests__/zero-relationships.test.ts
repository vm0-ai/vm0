import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { cronDrainRelationshipMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { zeroMemoryContract } from "@vm0/api-contracts/contracts/zero-memory";
import { zeroRelationshipsContract } from "@vm0/api-contracts/contracts/zero-relationships";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  createRelationshipAliasRaceTrigger$,
  deleteRelationshipAliasRaceTrigger$,
  deleteRelationshipRowsForFixture$,
  seedRelationshipRows$,
  type RelationshipAliasRaceTrigger,
  type RelationshipFixture,
} from "./helpers/zero-relationships";
import type { ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";
import {
  deleteSlackIntegrationFixture$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const connectorsApi = createConnectorBddApi(context);
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const CRON_SECRET = "test-cron-secret";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_GMAIL_INTERNAL_DATE = String(
  Date.parse("2026-01-02T03:04:05.000Z"),
);

afterEach(() => {
  clearMockNow();
});

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function relationshipsClient() {
  return setupApp({ context })(zeroRelationshipsContract);
}

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

function cronClient() {
  return setupApp({ context })(cronDrainRelationshipMemoryContract);
}

function cronHeaders(secret = CRON_SECRET) {
  return { authorization: `Bearer ${secret}` };
}

function fixtureActor(fixture: RelationshipFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

function configureGmailEnv(): void {
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
}

function configureGmailWatchMock(historyId = "100"): void {
  server.use(
    http.post("https://gmail.googleapis.com/gmail/v1/users/me/watch", () => {
      return HttpResponse.json({
        historyId,
        expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
      });
    }),
  );
}

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function configureGmailBackfillMocks(
  gmailEmail: string,
  args: {
    readonly duplicateMessage?: boolean;
    readonly bodyText?: string;
    readonly mimeType?: "text/plain" | "text/html";
    readonly expectedQueryIncludes?: readonly string[];
    readonly from?: string;
    readonly labelIds?: readonly string[];
    readonly messageId?: string;
    readonly internalDate?: string | null;
    readonly dateHeader?: string;
    readonly subject?: string;
    readonly threadId?: string;
    readonly to?: readonly string[];
    readonly cc?: readonly string[];
  } = {},
): string[] {
  const messageId = args.messageId ?? "msg-backfill-1";
  const threadId = args.threadId ?? "thread-backfill-1";
  const messages = [
    { id: messageId, threadId },
    ...(args.duplicateMessage ? [{ id: messageId, threadId }] : []),
  ];
  const queries: string[] = [];
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-access-token",
        );
        const query = new URL(request.url).searchParams.get("q") ?? "";
        queries.push(query);
        for (const expected of args.expectedQueryIncludes ?? [
          "newer_than:180d",
        ]) {
          expect(query).toContain(expected);
        }
        return HttpResponse.json({
          messages,
          resultSizeEstimate: messages.length,
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      () => {
        return HttpResponse.json({
          id: messageId,
          threadId,
          labelIds: args.labelIds ?? ["INBOX"],
          internalDate:
            args.internalDate === null
              ? undefined
              : (args.internalDate ?? DEFAULT_GMAIL_INTERNAL_DATE),
          payload: {
            mimeType: args.mimeType ?? "text/plain",
            headers: [
              ...(args.dateHeader
                ? [{ name: "Date", value: args.dateHeader }]
                : []),
              {
                name: "From",
                value: args.from ?? "Customer Example <customer@example.com>",
              },
              { name: "To", value: (args.to ?? [gmailEmail]).join(", ") },
              ...(args.cc ? [{ name: "Cc", value: args.cc.join(", ") }] : []),
              {
                name: "Subject",
                value: args.subject ?? "Security review follow-up",
              },
            ],
            body: {
              data: gmailBodyData(
                args.bodyText ?? "Please send the security review answer.",
              ),
            },
          },
        });
      },
    ),
  );
  return queries;
}

function configureRelationshipExtractionMock(): void {
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-openrouter-key",
      );
      const requestText = await request.text();
      expect(requestText).toContain("INTERNAL_RAW_HTML_MARKER");
      return HttpResponse.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                summary:
                  "Customer Example is waiting on a security review answer.",
                relationshipType: "External contact",
                interactionSummary:
                  "Customer Example asked for the security review answer.",
                items: [
                  {
                    kind: "open_loop",
                    text: "Send the security review answer.",
                    confidence: 90,
                  },
                ],
              }),
            },
          },
        ],
      });
    }),
  );
}

async function connectGmail(
  fixture: RelationshipFixture,
  gmailEmail: string,
): Promise<void> {
  const actor = fixtureActor(fixture);
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: gmailEmail,
  });
  const start = await connectorsApi.startOauth(actor, "gmail", "oauth");
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected Gmail OAuth start URL to include state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: "gmail-code",
    state,
  });
}

async function seedRelationshipFixture(
  enabled = true,
): Promise<RelationshipFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  await store.set(
    seedOrgMembership$,
    { orgId, userId, role: "admin" },
    context.signal,
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.RelationshipMemory]: enabled },
  );
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

async function deleteRelationshipFixture(
  fixture: RelationshipFixture,
): Promise<void> {
  await store.set(deleteRelationshipRowsForFixture$, fixture, context.signal);
  await deleteFeatureSwitchesForUser(context, fixture);
}

async function deleteRelationshipAliasRaceTrigger(
  trigger: RelationshipAliasRaceTrigger,
): Promise<void> {
  await store.set(deleteRelationshipAliasRaceTrigger$, trigger, context.signal);
}

async function deleteSlackFixture(
  fixture: SlackIntegrationFixture,
): Promise<void> {
  await store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
}

describe("GET /api/zero/relationships/*", () => {
  const track = createFixtureTracker(deleteRelationshipFixture);
  const trackSlack = createFixtureTracker(deleteSlackFixture);
  const trackAliasRace = createFixtureTracker(
    deleteRelationshipAliasRaceTrigger,
  );

  it("returns empty read responses in the current org-user scope", async () => {
    await track(seedRelationshipFixture());

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "security" },
      }),
      [200],
    );
    expect(search.body).toStrictEqual({
      relationships: [],
      pagination: {
        page: 1,
        pageSize: 100,
        total: 0,
        totalPages: 1,
        hasMore: false,
      },
    });

    const resolved = await accept(
      relationshipsClient().resolve({
        headers: authHeaders(),
        query: { email: "alice@acme.com" },
      }),
      [200],
    );
    expect(resolved.body).toStrictEqual({ relationship: null });
  });

  it("rejects reads when relationship memory is not enabled", async () => {
    const fixture = await track(seedRelationshipFixture(false));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "alice" },
      }),
      [403],
    );
    expect(response.body.error.message).toBe(
      "Relationship memory is not enabled for this organization.",
    );
  });

  it("paginates relationship search with total counts and server-side filters", async () => {
    const fixture = await track(seedRelationshipFixture());
    await store.set(
      seedRelationshipRows$,
      { fixture, count: 105 },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const firstPage = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 100 },
      }),
      [200],
    );
    expect(firstPage.body.relationships).toHaveLength(100);
    expect(firstPage.body.relationships[0]?.entity.displayName).toBe(
      "Relationship 001",
    );
    expect(firstPage.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 100,
      total: 105,
      totalPages: 2,
      hasMore: true,
    });

    const secondPage = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 2, limit: 100 },
      }),
      [200],
    );
    expect(secondPage.body.relationships).toHaveLength(5);
    expect(secondPage.body.relationships[0]?.entity.displayName).toBe(
      "Relationship 101",
    );
    expect(secondPage.body.pagination).toStrictEqual({
      page: 2,
      pageSize: 100,
      total: 105,
      totalPages: 2,
      hasMore: false,
    });

    const people = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 100, entityType: "person" },
      }),
      [200],
    );
    expect(people.body.relationships).toHaveLength(53);
    expect(people.body.pagination.total).toBe(53);

    const openLoops = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 100, itemKind: "open_loop" },
      }),
      [200],
    );
    expect(openLoops.body.relationships).toHaveLength(11);
    expect(openLoops.body.pagination.total).toBe(11);
  });

  it("does not enqueue duplicate Gmail backfill messages twice", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail, { duplicateMessage: true });
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );

    expect(drained.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 2,
      enqueued: 1,
    });
  });

  it("enables Gmail relationships and advances historical backfill from cron", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail);
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const initialStatus = await accept(
      relationshipsClient().gmailStatus({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(initialStatus.body).toMatchObject({
      provider: "gmail",
      connectorConnected: true,
      enabled: false,
      watchEnabled: false,
      backfill: { status: "idle", scannedCount: 0, enqueuedCount: 0 },
    });

    const enabled = await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      connectorConnected: true,
      enabled: true,
      watchEnabled: true,
      backfill: { status: "pending", scannedCount: 0, enqueuedCount: 0 },
    });

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 1,
    });
    expect(drained.body.processed).toBe(1);
    expect(drained.body.relationshipsUpdated).toBeGreaterThanOrEqual(1);

    const finalStatus = await accept(
      relationshipsClient().gmailStatus({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(finalStatus.body).toMatchObject({
      enabled: true,
      watchEnabled: true,
      backfill: {
        status: "done",
        estimatedTotal: 1,
        scannedCount: 1,
        enqueuedCount: 1,
        pendingSyncJobs: 0,
      },
    });

    const customerSearch = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "customer" },
      }),
      [200],
    );
    expect(
      customerSearch.body.relationships.some((relationship) => {
        return relationship.entity.primaryEmail === "customer@example.com";
      }),
    ).toBeTruthy();

    const allRelationships = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 100 },
      }),
      [200],
    );
    const person = allRelationships.body.relationships.find((relationship) => {
      return relationship.entity.primaryEmail === "customer@example.com";
    });
    const organization = allRelationships.body.relationships.find(
      (relationship) => {
        return (
          relationship.entity.type === "organization" &&
          relationship.entity.domain === "example.com"
        );
      },
    );
    expect(person).toMatchObject({
      entity: {
        type: "person",
        displayName: "customer@example.com",
        primaryEmail: "customer@example.com",
        domain: "example.com",
      },
    });
    expect(organization).toMatchObject({
      entity: {
        type: "organization",
        displayName: "Example",
        primaryEmail: null,
        domain: "example.com",
      },
    });
    expect(person?.id).not.toBe(organization?.id);
  });

  it("resolves the canonical relationship when Gmail extraction races entity alias creation", async () => {
    const fixture = await track(seedRelationshipFixture());
    const suffix = randomUUID().replaceAll("-", "");
    const targetEmail = `alias-race-${suffix}@example.test`;
    const raceTrigger = await trackAliasRace(
      Promise.resolve({
        displayName: targetEmail,
        identityKey: `person:${targetEmail}`,
        functionName: `vm0_test_claim_alias_${suffix}`,
        triggerName: `vm0_test_claim_alias_${suffix}`,
      }),
    );
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail, {
      from: `Alias Race <${targetEmail}>`,
      messageId: `msg-alias-race-${suffix}`,
      bodyText: "Please send the alias race follow-up.",
    });
    await store.set(
      createRelationshipAliasRaceTrigger$,
      { fixture, trigger: raceTrigger },
      context.signal,
    );
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );
    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.relationshipsUpdated).toBeGreaterThanOrEqual(1);

    const resolved = await accept(
      relationshipsClient().resolve({
        headers: authHeaders(),
        query: { email: targetEmail },
      }),
      [200],
    );
    expect(resolved.body.relationship).toMatchObject({
      entity: {
        type: "person",
        displayName: targetEmail,
        primaryEmail: targetEmail,
        domain: "example.test",
      },
    });

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: targetEmail, page: 1, limit: 100 },
      }),
      [200],
    );
    expect(search.body.relationships).toHaveLength(1);
    expect(search.body.relationships[0]?.id).toBe(
      resolved.body.relationship?.id,
    );
  });

  it("uses the Gmail message time for relationship state dates without fallback interactions", async () => {
    const messageOccurredAt = "2026-02-03T04:05:06.000Z";
    const jobRunAt = new Date("2026-05-06T07:08:09.000Z");
    mockNow(jobRunAt);
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail, {
      internalDate: String(Date.parse(messageOccurredAt)),
      dateHeader: "Fri, 01 Jan 2040 00:00:00 +0000",
    });
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.processed).toBe(1);

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "customer" },
      }),
      [200],
    );
    const customer = search.body.relationships.find((relationship) => {
      return relationship.entity.primaryEmail === "customer@example.com";
    });
    expect(customer?.lastInteractionAt).toBe(messageOccurredAt);
    expect(customer?.recentInteractions).toStrictEqual([]);
    expect(customer?.lastInteractionAt).not.toBe(jobRunAt.toISOString());
  });

  it("does not create relationship memory when Gmail internalDate is unavailable", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail, {
      internalDate: null,
      dateHeader: "Fri, 01 Jan 2040 00:00:00 +0000",
    });
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 0,
    });
    expect(drained.body.processed).toBe(0);
    expect(drained.body.relationshipsUpdated).toBe(0);

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "customer" },
      }),
      [200],
    );
    expect(search.body.relationships).toStrictEqual([]);
  });

  it("restarts Gmail backfill across archived and sent mail without re-enqueueing processed messages", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    const queries = configureGmailBackfillMocks(gmailEmail, {
      expectedQueryIncludes: ["in:anywhere", "newer_than:365d"],
      labelIds: ["SENT"],
      from: `Relationship User <${gmailEmail}>`,
      to: ["Recipient Example <recipient@example.com>"],
      subject: "Partnership follow-up",
      bodyText: "Following up about the partnership plan.",
    });
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const firstBackfill = await accept(
      relationshipsClient().gmailBackfill({
        headers: authHeaders(),
        body: {
          days: 365,
          includeArchived: true,
          includeSent: true,
        },
      }),
      [200],
    );
    expect(firstBackfill.body).toMatchObject({
      enabled: true,
      watchEnabled: true,
      backfill: { status: "pending", scannedCount: 0, enqueuedCount: 0 },
    });

    const firstDrain = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(firstDrain.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 1,
    });
    expect(queries.at(-1)).not.toContain("in:inbox");
    expect(queries.at(-1)).not.toContain("-in:sent");

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "recipient" },
      }),
      [200],
    );
    expect(
      search.body.relationships.some((relationship) => {
        return relationship.entity.primaryEmail === "recipient@example.com";
      }),
    ).toBeTruthy();

    await accept(
      relationshipsClient().gmailBackfill({
        headers: authHeaders(),
        body: {
          days: 365,
          includeArchived: true,
          includeSent: true,
        },
      }),
      [200],
    );
    const secondDrain = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(secondDrain.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 0,
    });

    const restartedStatus = await accept(
      relationshipsClient().gmailStatus({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(restartedStatus.body).toMatchObject({
      enabled: true,
      backfill: {
        status: "done",
        scannedCount: 1,
        enqueuedCount: 0,
      },
    });
  });

  it("stops and deletes a Gmail backfill job before restarting it", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    configureGmailWatchMock();
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const enabled = await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(enabled.body).toMatchObject({
      enabled: true,
      watchEnabled: true,
      backfill: { status: "pending" },
    });

    const stopped = await accept(
      relationshipsClient().gmailStopBackfill({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(stopped.body).toMatchObject({
      enabled: true,
      backfill: { status: "stopped" },
    });

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toStrictEqual({
      processed: 0,
      failed: 0,
      scanned: 0,
      enqueued: 0,
    });

    const deleted = await accept(
      relationshipsClient().gmailDeleteStoppedBackfill({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(deleted.body).toMatchObject({
      enabled: true,
      backfill: { status: "idle", scannedCount: 0, enqueuedCount: 0 },
    });

    const restarted = await accept(
      relationshipsClient().gmailBackfill({
        headers: authHeaders(),
        body: {
          days: 180,
          includeArchived: true,
          includeSent: true,
        },
      }),
      [200],
    );
    expect(restarted.body).toMatchObject({
      enabled: true,
      backfill: { status: "pending" },
    });

    await accept(
      relationshipsClient().gmailStopBackfill({
        headers: authHeaders(),
      }),
      [200],
    );
    await accept(
      relationshipsClient().gmailDeleteStoppedBackfill({
        headers: authHeaders(),
      }),
      [200],
    );
  });

  it("stores generated Gmail interaction summaries instead of raw body excerpts", async () => {
    const fixture = await track(seedRelationshipFixture());
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    configureGmailEnv();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    configureGmailWatchMock();
    configureGmailBackfillMocks(gmailEmail, {
      mimeType: "text/html",
      bodyText:
        "<center><style>.hidden{display:none}</style><div>INTERNAL_RAW_HTML_MARKER: please send the security review answer.</div></center>",
    });
    configureRelationshipExtractionMock();
    await connectGmail(fixture, gmailEmail);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );
    await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "customer" },
      }),
      [200],
    );
    const serialized = JSON.stringify(search.body);
    expect(serialized).toContain(
      "Customer Example asked for the security review answer.",
    );
    expect(serialized).not.toContain("<center>");
    expect(serialized).not.toContain("<style>");
    expect(serialized).not.toContain("INTERNAL_RAW_HTML_MARKER");

    const customer = search.body.relationships.find((relationship) => {
      return relationship.entity.primaryEmail === "customer@example.com";
    });
    expect(customer?.recentInteractions[0]?.snippet).toBe(
      "Customer Example asked for the security review answer.",
    );
    expect(customer?.items[0]?.sources[0]?.quote).toBeNull();
  });

  it("backfills Slack source memory and exposes it through memory sources", async () => {
    const fixture = await track(seedRelationshipFixture());
    const slackFixture = await trackSlack(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: fixture.orgId,
          slackWorkspaceId: "T-memory-backfill",
          slackWorkspaceName: "Memory Test Workspace",
        },
        context.signal,
      ),
    );
    const slackUser = await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: slackFixture.slackWorkspaceId,
        vm0UserId: fixture.userId,
        slackUserId: "U-memory-user",
      },
      context.signal,
    );
    configureGmailEnv();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    context.mocks.slack.conversations.list.mockResolvedValue({
      ok: true,
      channels: [
        {
          id: "C-memory",
          name: "memory",
          is_channel: true,
          is_member: true,
          is_archived: false,
        },
        {
          id: "C-not-member",
          name: "private-other",
          is_group: true,
          is_member: false,
          is_archived: false,
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    context.mocks.slack.conversations.history.mockResolvedValue({
      ok: true,
      messages: [
        {
          user: slackUser.slackUserId,
          ts: "1780000000.000100",
          text: "Follow up with the workspace launch plan.",
        },
        {
          user: "U-someone-else",
          ts: "1780000001.000100",
          text: "Other user's message",
        },
        {
          user: slackUser.slackUserId,
          ts: "1780000002.000100",
          text: "Bot-posted message",
          bot_id: "B-bot",
        },
      ],
      response_metadata: { next_cursor: "" },
    });

    const started = await accept(
      memoryClient().slackBackfill({
        headers: authHeaders(),
        body: {
          days: 180,
          includePublicChannels: true,
          includePrivateChannels: true,
          includeDirectMessages: false,
        },
      }),
      [200],
    );
    expect(started.body).toMatchObject({
      provider: "slack",
      workspaceConnected: true,
      userConnected: true,
      workspaceName: "Memory Test Workspace",
      backfill: { status: "pending", scannedCount: 0, recordedCount: 0 },
    });

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toStrictEqual({
      processed: 1,
      failed: 0,
      scanned: 3,
      enqueued: 1,
    });
    expect(drained.body.relationshipsUpdated).toBe(1);
    expect(context.mocks.slack.conversations.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        types: "public_channel,private_channel",
        exclude_archived: true,
      }),
    );
    expect(context.mocks.slack.conversations.history).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C-memory",
      }),
    );
    expect(context.mocks.slack.conversations.history).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "C-memory",
        latest: "1780000000.000100",
        inclusive: true,
        limit: 1,
      }),
    );

    const status = await accept(
      memoryClient().slackStatus({ headers: authHeaders() }),
      [200],
    );
    expect(status.body).toMatchObject({
      provider: "slack",
      backfill: {
        status: "done",
        scannedCount: 3,
        recordedCount: 1,
      },
    });

    const sources = await accept(
      memoryClient().sources({
        headers: authHeaders(),
        query: { provider: "slack", page: 1, limit: 10 },
      }),
      [200],
    );
    expect(sources.body.pagination).toMatchObject({
      page: 1,
      pageSize: 10,
      total: 1,
      totalPages: 1,
      hasMore: false,
    });
    expect(sources.body.sources).toHaveLength(1);
    expect(sources.body.sources[0]).toMatchObject({
      provider: "slack",
      sourceType: "slack_message",
      title: "Slack channel message",
      occurredAt: "2026-05-28T20:26:40.000Z",
      metadata: {
        workspaceId: "T-memory-backfill",
        channelId: "C-memory",
        channelType: "channel",
        messageTs: "1780000000.000100",
        senderId: "U-memory-user",
      },
    });
    expect(sources.body.sources[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const sourceId = sources.body.sources[0]?.id;
    expect(sourceId).toBeDefined();
    const sourceDetail = await accept(
      memoryClient().source({
        headers: authHeaders(),
        params: { sourceId: sourceId ?? randomUUID() },
      }),
      [200],
    );
    expect(sourceDetail.body).toMatchObject({
      id: sourceId,
      provider: "slack",
      sourceType: "slack_message",
      externalId: "T-memory-backfill:C-memory:1780000000.000100",
      connectorId: null,
      title: "Slack channel message",
      occurredAt: "2026-05-28T20:26:40.000Z",
      metadata: {
        workspaceId: "T-memory-backfill",
        channelId: "C-memory",
        channelType: "channel",
        threadId: null,
        messageTs: "1780000000.000100",
        senderId: "U-memory-user",
        participantIds: ["U-memory-user"],
        fileIds: [],
      },
    });

    const relationships = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "C-memory" },
      }),
      [200],
    );
    expect(relationships.body.relationships).toHaveLength(1);
    expect(relationships.body.relationships[0]).toMatchObject({
      entity: {
        type: "organization",
        displayName: "Slack channel C-memory",
      },
      relationshipType: null,
      status: "active",
      lastInteractionAt: "2026-05-28T20:26:40.000Z",
      recentInteractions: [],
    });
  });
});
