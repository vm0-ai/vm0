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
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  seedGraphExpansionMemories,
  seedRuntimeInjectionMemories,
  seedSemanticRecallMemory,
} from "../../../test-fixtures/relationship-memory";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import type { ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

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

function memoryClient() {
  return setupApp({ context })(zeroMemoryContract);
}

function relationshipsClient() {
  return setupApp({ context })(zeroRelationshipsContract);
}

function cronClient() {
  return setupApp({ context })(cronDrainRelationshipMemoryContract);
}

function cronHeaders() {
  return { authorization: `Bearer ${CRON_SECRET}` };
}

function fixtureActor(fixture: RelationshipFixture): ApiTestUser {
  return {
    userId: fixture.userId,
    orgId: fixture.orgId,
    orgRole: "org:admin",
    email: `${fixture.userId}@example.test`,
  };
}

function gmailBodyData(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function configureExtractionMock(): void {
  mockOptionalEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  server.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", () => {
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

// The drain cron works a shared global job queue, so another test file's
// worker can claim this fixture's jobs and replay its Gmail calls against
// that worker's own MSW handlers. Every handler therefore authenticates the
// per-fixture access token the way the real provider would: foreign requests
// get 401, the job attempt fails, and the job returns to the queue until this
// worker (whose handlers know the token) processes it.
function configureGmailMocks(gmailEmail: string, accessToken: string): void {
  const messageId = `msg-memory-recall-${randomUUID()}`;
  const threadId = `thread-memory-recall-${randomUUID()}`;
  mockEnv("CRON_SECRET", CRON_SECRET);
  mockOptionalEnv("GMAIL_PUBSUB_TOPIC_NAME", GMAIL_TOPIC_NAME);
  configureExtractionMock();
  const unauthorized = (request: Request): boolean => {
    return request.headers.get("authorization") !== `Bearer ${accessToken}`;
  };
  server.use(
    http.post(
      "https://gmail.googleapis.com/gmail/v1/users/me/watch",
      ({ request }) => {
        if (unauthorized(request)) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
        return HttpResponse.json({
          historyId: "100",
          expiration: String(now() + 7 * 24 * 60 * 60 * 1000),
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ({ request }) => {
        if (unauthorized(request)) {
          return HttpResponse.json({ error: "invalid token" }, { status: 401 });
        }
        return HttpResponse.json({
          messages: [{ id: messageId, threadId }],
          resultSizeEstimate: 1,
        });
      },
    ),
    http.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId",
      ({ request, params }) => {
        if (unauthorized(request) || params.messageId !== messageId) {
          return HttpResponse.json({ error: "not found" }, { status: 404 });
        }
        return HttpResponse.json({
          id: messageId,
          threadId,
          labelIds: ["INBOX"],
          internalDate: String(Date.parse("2026-01-02T03:04:05.000Z")),
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

async function seedRelationshipMemory(): Promise<RelationshipFixture> {
  const fixture = await seedRelationshipFixture();
  const gmailEmail = `relationship-${randomUUID()}@example.com`;
  const accessToken = `gmail-access-token-${randomUUID()}`;
  configureGmailMocks(gmailEmail, accessToken);
  await connectGmail(fixture, gmailEmail, accessToken);
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    relationshipsClient().gmailEnable({
      headers: authHeaders(),
    }),
    [200],
  );
  // The drain cron works a shared global job queue, so a concurrently running
  // file's drain can claim this fixture's job (its counters then land in the
  // other worker's response). Poll the product read surface for the outcome
  // instead of asserting this drain call's counters.
  await expect
    .poll(async () => {
      await accept(cronClient().drain({ headers: cronHeaders() }), [200]);
      const recalled = await accept(
        memoryClient().recall({
          headers: authHeaders(),
          query: { q: "security review", limit: 5 },
        }),
        [200],
      );
      return recalled.body.memories.length;
    })
    .toBeGreaterThanOrEqual(1);
  return fixture;
}

interface RelationshipFixtureOptions {
  readonly relationshipMemoryEnabled?: boolean;
  readonly runtimeInjectionEnabled?: boolean;
}

function normalizeRelationshipFixtureOptions(
  options: boolean | RelationshipFixtureOptions,
): Required<RelationshipFixtureOptions> {
  if (typeof options === "boolean") {
    return {
      relationshipMemoryEnabled: options,
      runtimeInjectionEnabled: false,
    };
  }
  return {
    relationshipMemoryEnabled: options.relationshipMemoryEnabled ?? true,
    runtimeInjectionEnabled: options.runtimeInjectionEnabled ?? false,
  };
}

async function seedRelationshipFixture(
  options: boolean | RelationshipFixtureOptions = true,
): Promise<RelationshipFixture> {
  const normalized = normalizeRelationshipFixtureOptions(options);
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
    {
      [FeatureSwitchKey.RelationshipMemory]:
        normalized.relationshipMemoryEnabled,
      [FeatureSwitchKey.RelationshipMemoryRuntimeInjection]:
        normalized.runtimeInjectionEnabled,
    },
  );
  mocks.clerk.session(userId, orgId);
  return { orgId, userId };
}

afterEach(() => {
  mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", undefined);
});

describe("GET /api/zero/memory/recall", () => {
  it("rejects recall when relationship memory is disabled", async () => {
    await seedRelationshipFixture(false);

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "relationship" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Relationship memory is not enabled for this organization.",
    );
  });

  it("recalls matching structured relationship memory", async () => {
    await seedRelationshipMemory();

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: "security review", limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBe("security review");
    expect(response.body.memories.length).toBeGreaterThanOrEqual(1);
    expect(response.body.memories[0]).toMatchObject({
      kind: "open_loop",
      relationship: {
        entity: {
          primaryEmail: "customer@example.com",
          type: "person",
        },
      },
    });
  });

  it("recalls semantic memory without lexical overlap", async () => {
    const fixture = await seedRelationshipFixture();
    const query = "cash management sweep fund";
    await seedSemanticRecallMemory(fixture, query);
    mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", "test");

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: query, limit: 5 },
      }),
      [200],
    );

    expect(response.body.memories).toHaveLength(1);
    expect(response.body.memories[0]).toMatchObject({
      kind: "preference",
      text: "The user prefers JPM IJTXX Treasury allocation.",
      relationship: {
        entity: {
          displayName: "Portfolio Settings",
          type: "organization",
        },
      },
    });
  });

  it("expands semantic recall through related graph memories", async () => {
    const fixture = await seedRelationshipFixture();
    const query = "platform refactor nickname";
    await seedGraphExpansionMemories(fixture, query);
    mockOptionalEnv("ZERO_MEMORY_EMBEDDING_PROVIDER", "test");

    const response = await accept(
      memoryClient().recall({
        headers: authHeaders(),
        query: { q: query, limit: 2 },
      }),
      [200],
    );

    expect(
      response.body.memories.map((memory) => {
        return memory.text;
      }),
    ).toStrictEqual(
      expect.arrayContaining([
        "The infrastructure rewrite uses Lucent as its internal migration name.",
        "Ask Lancy for the Lucent migration rollout owner.",
      ]),
    );
  });

  it("returns prompt-ready memory context", async () => {
    await seedRelationshipMemory();

    const response = await accept(
      memoryClient().context({
        headers: authHeaders(),
        query: { limit: 5 },
      }),
      [200],
    );

    expect(response.body.query).toBeNull();
    expect(response.body.context).toContain("Structured memory:");
    expect(response.body.context).toContain("Open loops:");
    expect(response.body.context).toContain("customer@example.com");
    expect(response.body.memories.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects injection preview when runtime injection is disabled", async () => {
    await seedRelationshipFixture({
      relationshipMemoryEnabled: true,
      runtimeInjectionEnabled: false,
    });

    const response = await accept(
      memoryClient().injectionPreview({
        headers: authHeaders(),
        body: { prompt: "Prepare the security review" },
      }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Relationship memory runtime injection is not enabled for this organization.",
    );
  });

  it("previews runtime memory system prompt injection", async () => {
    const fixture = await seedRelationshipFixture({
      relationshipMemoryEnabled: true,
      runtimeInjectionEnabled: true,
    });
    await seedRuntimeInjectionMemories(fixture);

    const response = await accept(
      memoryClient().injectionPreview({
        headers: authHeaders(),
        body: { prompt: "Prepare the security review" },
      }),
      [200],
    );

    expect(response.body.prompt).toBe("Prepare the security review");
    expect(response.body.appendSystemPrompt).toContain("# Zero Memory Context");
    expect(response.body.appendSystemPrompt).toContain("Stable profile:");
    expect(response.body.appendSystemPrompt).toContain("Current context:");
    expect(response.body.appendSystemPrompt).toContain(
      "The user prefers concise launch summaries.",
    );
    expect(response.body.appendSystemPrompt).toContain(
      "validating runtime memory injection",
    );
    expect(response.body.profile.static).toHaveLength(1);
    expect(response.body.profile.dynamic).toHaveLength(2);
    expect(response.body.stats.injectedCount).toBeGreaterThan(0);
  });
});
