import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { cronDrainRelationshipMemoryContract } from "@vm0/api-contracts/contracts/cron";
import { zeroRelationshipsContract } from "@vm0/api-contracts/contracts/zero-relationships";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const connectorsApi = createConnectorBddApi(context);
const GMAIL_TOPIC_NAME = "projects/vm0-ai-488909/topics/gmail-events";
const CRON_SECRET = "test-cron-secret";

interface RelationshipFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function relationshipsClient() {
  return setupApp({ context })(zeroRelationshipsContract);
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
  args: { readonly duplicateMessage?: boolean } = {},
): void {
  const messages = [
    { id: "msg-backfill-1", threadId: "thread-backfill-1" },
    ...(args.duplicateMessage
      ? [{ id: "msg-backfill-1", threadId: "thread-backfill-1" }]
      : []),
  ];
  server.use(
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer gmail-access-token",
        );
        expect(new URL(request.url).searchParams.get("q")).toContain(
          "newer_than:180d",
        );
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
          id: "msg-backfill-1",
          threadId: "thread-backfill-1",
          labelIds: ["INBOX"],
          payload: {
            mimeType: "text/plain",
            headers: [
              {
                name: "From",
                value: "Customer Example <customer@example.com>",
              },
              { name: "To", value: gmailEmail },
              { name: "Subject", value: "Security review follow-up" },
            ],
            body: {
              data: gmailBodyData("Please send the security review answer."),
            },
          },
        });
      },
    ),
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
  if (enabled) {
    await updateFeatureSwitchesForUser(
      context,
      { orgId, userId },
      { [FeatureSwitchKey.RelationshipMemory]: true },
    );
  }
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

async function deleteRelationshipFixture(
  fixture: RelationshipFixture,
): Promise<void> {
  await deleteFeatureSwitchesForUser(context, fixture);
}

describe("GET /api/zero/relationships/*", () => {
  const track = createFixtureTracker(deleteRelationshipFixture);

  it("returns empty read responses in the current org-user scope", async () => {
    await track(seedRelationshipFixture());

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "security" },
      }),
      [200],
    );
    expect(search.body).toStrictEqual({ relationships: [] });

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

    const search = await accept(
      relationshipsClient().search({
        headers: authHeaders(),
        query: { q: "customer" },
      }),
      [200],
    );
    expect(
      search.body.relationships.some((relationship) => {
        return relationship.entity.primaryEmail === "customer@example.com";
      }),
    ).toBeTruthy();
  });
});
