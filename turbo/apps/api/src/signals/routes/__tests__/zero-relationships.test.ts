import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID } from "node:crypto";

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
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createGithubBddApi } from "./helpers/api-bdd-github";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { mockNotionConnectorOAuth } from "./helpers/api-bdd-workflows";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/zero-integrations-slack";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const bdd = createBddApi(context);
const gh = createGithubBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const CRON_SECRET = "test-cron-secret";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_GMAIL_INTERNAL_DATE = String(
  Date.parse("2026-01-02T03:04:05.000Z"),
);

interface RelationshipFixture {
  readonly orgId: string;
  readonly userId: string;
}

interface GmailBackfillMessageFixture {
  readonly messageId: string;
  readonly threadId?: string;
  readonly from?: string;
  readonly labelIds?: readonly string[];
  readonly internalDate?: string | null;
  readonly dateHeader?: string;
  readonly subject?: string;
  readonly bodyText?: string;
  readonly mimeType?: "text/plain" | "text/html";
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
}

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

function configureGmailWatchMock(accessToken: string, historyId = "100"): void {
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      ({ request }) => {
        if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
        return HttpResponse.json({
          historyId,
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
  );
}

function privateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function githubBackfillIssueFixture(
  args: { readonly pullRequest?: boolean } = {},
) {
  return {
    number: 42,
    title: args.pullRequest
      ? "Backfill memory pull request"
      : "Backfill memory issue",
    body: "Follow up on trusted contributor context.",
    html_url: args.pullRequest
      ? "https://github.com/vm0-ai/vm0/pull/42"
      : "https://github.com/vm0-ai/vm0/issues/42",
    created_at: "2026-07-01T12:00:00.000Z",
    updated_at: "2026-07-06T12:00:00.000Z",
    user: { id: 101, login: "lancy", type: "User" },
    labels: [{ name: "memory" }],
    ...(args.pullRequest
      ? {
          pull_request: {
            url: "https://api.github.com/repos/vm0-ai/vm0/pulls/42",
          },
        }
      : {}),
  };
}

function configureGithubAppBackfillMocks(args: {
  readonly remoteInstallationId: string;
  readonly token: string;
  readonly pullRequest?: boolean;
}): void {
  mockOptionalEnv("GITHUB_APP_ID", "123456");
  mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", privateKeyBase64());
  server.use(
    http.post(
      `https://api.github.com/app/installations/${args.remoteInstallationId}/access_tokens`,
      () => {
        return HttpResponse.json({
          token: args.token,
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
    http.get("https://api.github.com/repos/vm0-ai/vm0/issues", () => {
      return HttpResponse.json([
        githubBackfillIssueFixture({ pullRequest: args.pullRequest }),
      ]);
    }),
    http.get(
      "https://api.github.com/repos/vm0-ai/vm0/issues/42/comments",
      () => {
        return HttpResponse.json([
          {
            id: 4242,
            body: "Trusted comment for memory.",
            created_at: "2026-07-06T12:05:00.000Z",
            user: { id: 101, login: "lancy", type: "User" },
          },
          {
            id: 4243,
            body: "Untrusted comment.",
            created_at: "2026-07-06T12:06:00.000Z",
            user: { id: 303, login: "external", type: "User" },
          },
        ]);
      },
    ),
    http.get("https://api.github.com/repos/vm0-ai/vm0/issues/42", () => {
      return HttpResponse.json(
        githubBackfillIssueFixture({ pullRequest: args.pullRequest }),
      );
    }),
    http.get(
      "https://api.github.com/repos/vm0-ai/vm0/issues/comments/4242",
      () => {
        return HttpResponse.json({
          id: 4242,
          body: "Trusted comment for memory.",
          created_at: "2026-07-06T12:05:00.000Z",
          user: { id: 101, login: "lancy", type: "User" },
        });
      },
    ),
  );
}

async function seedGithubMemoryInstallation(
  fixture: RelationshipFixture,
  args: {
    readonly includeIssues?: boolean;
    readonly includePullRequests?: boolean;
    readonly includeComments?: boolean;
  } = {},
): Promise<{ readonly remoteInstallationId: string }> {
  const actor = fixtureActor(fixture);
  const agent = await bdd.createAgent(actor, {
    displayName: "GitHub Memory Agent",
  });
  const installed = await gh.installGithubApp(actor, agent.agentId, {
    oauthCode: {
      code: `gh-memory-${randomUUID().slice(0, 8)}`,
      githubUserId: "101",
      login: "lancy",
    },
  });
  mocks.clerk.session(fixture.userId, fixture.orgId);

  await accept(
    memoryClient().githubConfigure({
      headers: authHeaders(),
      body: {
        repositories: [
          {
            fullName: "vm0-ai/vm0",
            name: "vm0",
            defaultBranch: "main",
            selected: true,
            includeIssues: args.includeIssues ?? true,
            includePullRequests: args.includePullRequests ?? true,
            includeComments: args.includeComments ?? true,
            trustedContributors: [{ githubUserId: "101", login: "lancy" }],
          },
        ],
      },
    }),
    [200],
  );
  return { remoteInstallationId: installed.remoteInstallationId };
}

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

// The drain cron works a shared global job queue, so another test file's
// worker can claim this fixture's jobs and replay its Gmail calls against
// this worker's handlers. Handlers authenticate the per-fixture access token
// the way the real provider would: foreign requests get 401/404, that job
// attempt fails, and the queue retries until the owning worker processes it.
function configureGmailBackfillMocks(
  gmailEmail: string,
  accessToken: string,
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
    readonly messages?: readonly GmailBackfillMessageFixture[];
  } = {},
): string[] {
  const defaultMessageId = `msg-backfill-${randomUUID()}`;
  const defaultThreadId = `thread-backfill-${randomUUID()}`;
  const messageFixtures = args.messages ?? [
    {
      messageId: args.messageId ?? defaultMessageId,
      threadId: args.threadId ?? defaultThreadId,
      from: args.from,
      labelIds: args.labelIds,
      internalDate: args.internalDate,
      dateHeader: args.dateHeader,
      subject: args.subject,
      bodyText: args.bodyText,
      mimeType: args.mimeType,
      to: args.to,
      cc: args.cc,
    },
  ];
  const messages = messageFixtures.flatMap((message) => {
    const listed = {
      id: message.messageId,
      threadId: message.threadId ?? message.messageId,
    };
    return args.duplicateMessage ? [listed, listed] : [listed];
  });
  const queries: string[] = [];
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
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
      ({ request, params }) => {
        if (request.headers.get("authorization") !== `Bearer ${accessToken}`) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
        const requestedMessageId = String(params.messageId);
        const message = messageFixtures.find((fixture) => {
          return fixture.messageId === requestedMessageId;
        });
        if (!message) {
          return HttpResponse.json(
            { error: "message not found" },
            { status: 404 },
          );
        }
        return HttpResponse.json({
          id: message.messageId,
          threadId: message.threadId ?? message.messageId,
          labelIds: message.labelIds ?? ["INBOX"],
          internalDate:
            message.internalDate === null
              ? undefined
              : (message.internalDate ?? DEFAULT_GMAIL_INTERNAL_DATE),
          payload: {
            mimeType: message.mimeType ?? "text/plain",
            headers: [
              ...(message.dateHeader
                ? [{ name: "Date", value: message.dateHeader }]
                : []),
              {
                name: "From",
                value:
                  message.from ?? "Customer Example <customer@example.com>",
              },
              { name: "To", value: (message.to ?? [gmailEmail]).join(", ") },
              ...(message.cc
                ? [{ name: "Cc", value: message.cc.join(", ") }]
                : []),
              {
                name: "Subject",
                value: message.subject ?? "Security review follow-up",
              },
            ],
            body: {
              data: gmailBodyData(
                message.bodyText ?? "Please send the security review answer.",
              ),
            },
          },
        });
      },
    ),
  );
  return queries;
}

function configureRelationshipExtractionMock(
  options: { requiredRequestText?: string } = {},
): void {
  server.use(
    http.post(OPENROUTER_URL, async ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-openrouter-key",
      );
      const requestText = await request.text();
      if (options.requiredRequestText) {
        expect(requestText).toContain(options.requiredRequestText);
      }
      const personTarget = requestText.includes(
        String.raw`\"type\": \"person\"`,
      );
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
                items: personTarget
                  ? [
                      {
                        kind: "open_loop",
                        text: "Send the security review answer.",
                        confidence: 90,
                      },
                    ]
                  : [],
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
  accessToken: string,
): Promise<void> {
  const actor = fixtureActor(fixture);
  mockGmailConnectorOAuth({
    accessToken,
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

describe("GET /api/zero/relationships/*", () => {
  it("returns empty read responses in the current org-user scope", async () => {
    await seedRelationshipFixture();

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
    const fixture = await seedRelationshipFixture(false);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    const domainSuffix = randomUUID();
    configureGmailEnv();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    configureRelationshipExtractionMock();
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken, {
      messages: [1, 2, 3].map((index) => {
        return {
          messageId: `msg-pagination-${index}-${domainSuffix}`,
          threadId: `thread-pagination-${index}-${domainSuffix}`,
          from: `Contact ${index} <contact-${index}@rel-${index}-${domainSuffix}.test>`,
          internalDate: String(Date.parse(`2026-01-0${index}T03:04:05.000Z`)),
          subject: `Relationship pagination ${index}`,
          bodyText: `Please follow up on relationship pagination ${index}.`,
        };
      }),
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    await accept(
      relationshipsClient().gmailEnable({
        headers: authHeaders(),
      }),
      [200],
    );
    // The drain cron works a shared global job queue, so a concurrently
    // running file's drain can claim this fixture's jobs (its counters then
    // land in the other worker's response). Poll the fixture-scoped search
    // until all six relationships (3 persons + 3 organizations) exist instead
    // of asserting this drain call's counters.
    await expect
      .poll(async () => {
        await accept(cronClient().drain({ headers: cronHeaders() }), [200]);
        const search = await accept(
          relationshipsClient().search({
            headers: authHeaders(),
            query: { page: 1, limit: 100 },
          }),
          [200],
        );
        return search.body.pagination.total;
      })
      .toBe(6);

    const firstPage = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 4 },
      }),
      [200],
    );
    expect(firstPage.body.relationships).toHaveLength(4);
    expect(firstPage.body.pagination).toStrictEqual({
      page: 1,
      pageSize: 4,
      total: 6,
      totalPages: 2,
      hasMore: true,
    });

    const secondPage = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 2, limit: 4 },
      }),
      [200],
    );
    expect(secondPage.body.relationships).toHaveLength(2);
    expect(secondPage.body.pagination).toStrictEqual({
      page: 2,
      pageSize: 4,
      total: 6,
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
    expect(people.body.relationships).toHaveLength(3);
    expect(people.body.pagination.total).toBe(3);

    const openLoops = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { page: 1, limit: 100, itemKind: "open_loop" },
      }),
      [200],
    );
    expect(openLoops.body.relationships).toHaveLength(3);
    expect(openLoops.body.pagination.total).toBe(3);
    expect(
      openLoops.body.relationships.every((relationship) => {
        return relationship.items.some((item) => {
          return item.kind === "open_loop";
        });
      }),
    ).toBeTruthy();
  });

  it("does not enqueue duplicate Gmail backfill messages twice", async () => {
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken, {
      duplicateMessage: true,
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken);
    await connectGmail(fixture, gmailEmail, gmailToken);
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

  it("uses the Gmail message time for relationship state dates without fallback interactions", async () => {
    const messageOccurredAt = "2026-02-03T04:05:06.000Z";
    const jobRunAt = new Date("2026-05-06T07:08:09.000Z");
    mockNow(jobRunAt);
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken, {
      internalDate: String(Date.parse(messageOccurredAt)),
      dateHeader: "Fri, 01 Jan 2040 00:00:00 +0000",
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken, {
      internalDate: null,
      dateHeader: "Fri, 01 Jan 2040 00:00:00 +0000",
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    const queries = configureGmailBackfillMocks(gmailEmail, gmailToken, {
      expectedQueryIncludes: ["in:anywhere", "newer_than:365d"],
      labelIds: ["SENT"],
      from: `Relationship User <${gmailEmail}>`,
      to: ["Recipient Example <recipient@example.com>"],
      subject: "Partnership follow-up",
      bodyText: "Following up about the partnership plan.",
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    configureGmailWatchMock(gmailToken);
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const gmailEmail = `relationship-${randomUUID()}@example.com`;
    const gmailToken = `gmail-access-token-${randomUUID()}`;
    configureGmailEnv();
    mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
    configureGmailWatchMock(gmailToken);
    configureGmailBackfillMocks(gmailEmail, gmailToken, {
      mimeType: "text/html",
      bodyText:
        "<center><style>.hidden{display:none}</style><div>INTERNAL_RAW_HTML_MARKER: please send the security review answer.</div></center>",
    });
    configureRelationshipExtractionMock({
      requiredRequestText: "INTERNAL_RAW_HTML_MARKER",
    });
    await connectGmail(fixture, gmailEmail, gmailToken);
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
    const fixture = await seedRelationshipFixture();
    const slackWorkspaceId = `T${randomUUID().replaceAll("-", "").slice(0, 9)}`;
    const slackChannelId = `C${randomUUID().replaceAll("-", "").slice(0, 9)}`;
    const slackFixture = await store.set(
      seedSlackOrgInstallation$,
      {
        orgId: fixture.orgId,
        slackWorkspaceId,
        slackWorkspaceName: "Memory Test Workspace",
      },
      context.signal,
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
          id: slackChannelId,
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
        channel: slackChannelId,
      }),
    );
    expect(context.mocks.slack.conversations.history).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: slackChannelId,
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
        workspaceId: slackWorkspaceId,
        channelId: slackChannelId,
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
      externalId: `${slackWorkspaceId}:${slackChannelId}:1780000000.000100`,
      connectorId: null,
      title: "Slack channel message",
      occurredAt: "2026-05-28T20:26:40.000Z",
      metadata: {
        workspaceId: slackWorkspaceId,
        channelId: slackChannelId,
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
        query: { q: slackChannelId },
      }),
      [200],
    );
    expect(relationships.body.relationships).toHaveLength(1);
    expect(relationships.body.relationships[0]).toMatchObject({
      entity: {
        type: "organization",
        displayName: `Slack channel ${slackChannelId}`,
      },
      relationshipType: null,
      status: "active",
      lastInteractionAt: "2026-05-28T20:26:40.000Z",
      recentInteractions: [],
    });
  });

  it("backfills GitHub source memory from selected repos and trusted contributors", async () => {
    const fixture = await seedRelationshipFixture();
    configureGmailEnv();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const installation = await seedGithubMemoryInstallation(fixture);
    configureGithubAppBackfillMocks({
      remoteInstallationId: installation.remoteInstallationId,
      token: "ghs_memory_backfill",
    });

    const started = await accept(
      memoryClient().githubBackfill({
        headers: authHeaders(),
        body: { days: 180 },
      }),
      [200],
    );
    expect(started.body).toMatchObject({
      provider: "github",
      connected: true,
      selectedRepositoryCount: 1,
      trustedContributorCount: 1,
      backfill: { status: "pending", scannedCount: 0, recordedCount: 0 },
    });

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toMatchObject({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 2,
    });

    const sources = await accept(
      memoryClient().sources({
        headers: authHeaders(),
        query: { provider: "github", page: 1, limit: 10 },
      }),
      [200],
    );
    expect(sources.body.sources).toHaveLength(2);
    expect(sources.body.sources).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "github",
          sourceType: "github_issue",
          title: "Backfill memory issue",
          metadata: expect.objectContaining({
            githubRepository: "vm0-ai/vm0",
            githubActorLogin: "lancy",
            githubSubjectNumber: 42,
          }),
        }),
        expect.objectContaining({
          provider: "github",
          sourceType: "github_issue_comment",
          title: "Backfill memory issue",
          metadata: expect.objectContaining({
            githubRepository: "vm0-ai/vm0",
            githubActorLogin: "lancy",
            githubSubjectNumber: 42,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(sources.body)).not.toContain("external");
  });

  it("does not backfill GitHub comments when the parent pull request type is disabled", async () => {
    const fixture = await seedRelationshipFixture();
    configureGmailEnv();
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const installation = await seedGithubMemoryInstallation(fixture, {
      includePullRequests: false,
      includeComments: true,
    });
    configureGithubAppBackfillMocks({
      remoteInstallationId: installation.remoteInstallationId,
      token: "ghs_memory_backfill_pr_disabled",
      pullRequest: true,
    });

    await accept(
      memoryClient().githubBackfill({
        headers: authHeaders(),
        body: { days: 180 },
      }),
      [200],
    );

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toMatchObject({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 0,
    });

    const sources = await accept(
      memoryClient().sources({
        headers: authHeaders(),
        query: { provider: "github", page: 1, limit: 10 },
      }),
      [200],
    );
    expect(sources.body.sources).toHaveLength(0);
  });

  it("backfills Notion workspace pages with a document limit", async () => {
    const fixture = await seedRelationshipFixture();
    configureGmailEnv();
    const actor = fixtureActor(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockNotionConnectorOAuth({ accessToken: "notion-memory-token" });
    const start = await connectorsApi.startOauth(actor, "notion", "oauth");
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected Notion OAuth start URL to include state");
    }
    await connectorsApi.completeOauthCallback("notion", {
      code: "notion-code",
      state,
    });
    server.use(
      http.post("https://api.notion.com/v1/search", ({ request }) => {
        if (
          request.headers.get("authorization") !== "Bearer notion-memory-token"
        ) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
        return HttpResponse.json({
          results: [
            {
              object: "page",
              id: "11111111-1111-4111-8111-111111111111",
              created_time: "2026-07-01T12:00:00.000Z",
              last_edited_time: "2026-07-06T12:00:00.000Z",
              archived: false,
              in_trash: false,
              url: "https://www.notion.so/11111111111141118111111111111111",
              parent: { type: "workspace" },
              properties: {
                Name: {
                  type: "title",
                  title: [{ plain_text: "Workspace memory page" }],
                },
              },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }),
    );

    const started = await accept(
      memoryClient().notionBackfill({
        headers: authHeaders(),
        body: { days: 180, documentLimit: 5 },
      }),
      [200],
    );
    expect(started.body).toMatchObject({
      provider: "notion",
      connected: true,
      backfill: { status: "pending", scannedCount: 0, recordedCount: 0 },
    });

    const drained = await accept(
      cronClient().drain({
        headers: cronHeaders(),
      }),
      [200],
    );
    expect(drained.body.backfill).toMatchObject({
      processed: 1,
      failed: 0,
      scanned: 1,
      enqueued: 1,
    });

    const sources = await accept(
      memoryClient().sources({
        headers: authHeaders(),
        query: { provider: "notion", page: 1, limit: 10 },
      }),
      [200],
    );
    expect(sources.body.sources).toHaveLength(1);
    expect(sources.body.sources[0]).toMatchObject({
      provider: "notion",
      sourceType: "notion_page",
      title: "Workspace memory page",
      metadata: {
        notionPageId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });
});
