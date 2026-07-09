import { createHmac, randomUUID } from "node:crypto";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { clearMockedEnv, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/zero-feature-switches";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const WORKFLOW_TRIGGER_STATE_PATH = "/api/test/workflow-trigger-state/action";
const CRON_EXECUTE_WORKFLOW_TRIGGERS_PATH =
  "/api/cron/execute-workflow-triggers";

const WORKFLOW_NAME = "notion-webhook-workflow";
const CRON_SECRET = "test-cron-secret";
const NOTION_PARENT_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_CHILD_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_DATABASE_ID = "77777777-7777-4777-8777-777777777777";
const NOTION_DATA_SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const NOTION_PARENT_PAGE_URL =
  "https://www.notion.so/Roadmap-11111111111141118111111111111111";
const NOTION_CHILD_PAGE_URL =
  "https://www.notion.so/Launch-notes-22222222222242228222222222222222";
const NOTION_DATABASE_URL =
  "https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa&source=copy_link";
const NOTION_DATA_SOURCE_URL =
  "https://www.notion.so/Bug-Bash-88888888888848888888888888888888";
const NOTION_WEBHOOK_TOKEN = "notion-webhook-verification-token";
const NOTION_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTION_SUBSCRIPTION_ID = "44444444-4444-4444-8444-444444444444";
const NOTION_INTEGRATION_ID = "55555555-5555-4555-8555-555555555555";
const NOTION_AUTHOR_ID = "66666666-6666-4666-8666-666666666666";

afterEach(() => {
  clearMockedEnv();
  clearMockNow();
});

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function triggersClient() {
  return setupApp({ context })(zeroWorkflowTriggersContract);
}

async function workflowTriggerStateAction(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await createApp({ signal: context.signal }).request(
    WORKFLOW_TRIGGER_STATE_PATH,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function enableNotionWorkflowTriggers(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.NotionWorkflowTriggers]: true,
  });
}

async function seedNotionConnector(fixture: WorkflowsFixture): Promise<string> {
  const result = await workflowTriggerStateAction({
    action: "seed-connector",
    org_id: fixture.orgId,
    user_id: fixture.userId,
    connector_type: "notion",
    access_token: "notion-access-token",
  });
  expect(typeof result.connector_id).toBe("string");
  return result.connector_id as string;
}

function configureNotionParentPageMock(): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(params.pageId).toBe(NOTION_PARENT_PAGE_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "page",
          id: NOTION_PARENT_PAGE_ID,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time: "2026-07-01T00:00:00.000Z",
          archived: false,
          in_trash: false,
          url: NOTION_PARENT_PAGE_URL,
          parent: { type: "workspace" },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ type: "text", plain_text: "Roadmap" }],
            },
          },
        });
      },
    ),
  );
}

function configureNotionChildPageMock(
  parent:
    | { readonly type: "page_id"; readonly page_id: string }
    | {
        readonly type: "data_source_id";
        readonly data_source_id: string;
        readonly database_id?: string;
      } = { type: "page_id", page_id: NOTION_PARENT_PAGE_ID },
  options: {
    readonly title?: string;
    readonly lastEditedTime?: string;
    readonly extraProperties?: Record<string, unknown>;
  } = {},
): void {
  const title = options.title ?? "Launch notes";
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(params.pageId).toBe(NOTION_CHILD_PAGE_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "page",
          id: NOTION_CHILD_PAGE_ID,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time:
            options.lastEditedTime ?? "2026-07-06T12:00:00.000Z",
          archived: false,
          in_trash: false,
          url: NOTION_CHILD_PAGE_URL,
          parent,
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ type: "text", plain_text: title }],
            },
            ...options.extraProperties,
          },
        });
      },
    ),
  );
}

function configureNotionParentAndChildPageMock(): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        if (params.pageId === NOTION_PARENT_PAGE_ID) {
          return HttpResponse.json({
            object: "page",
            id: NOTION_PARENT_PAGE_ID,
            created_time: "2026-07-01T00:00:00.000Z",
            last_edited_time: "2026-07-01T00:00:00.000Z",
            archived: false,
            in_trash: false,
            url: NOTION_PARENT_PAGE_URL,
            parent: { type: "workspace" },
            properties: {
              title: {
                id: "title",
                type: "title",
                title: [{ type: "text", plain_text: "Roadmap" }],
              },
            },
          });
        }
        expect(params.pageId).toBe(NOTION_CHILD_PAGE_ID);
        return HttpResponse.json({
          object: "page",
          id: NOTION_CHILD_PAGE_ID,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time: "2026-07-06T12:00:00.000Z",
          archived: false,
          in_trash: false,
          url: NOTION_CHILD_PAGE_URL,
          parent: { type: "page_id", page_id: NOTION_PARENT_PAGE_ID },
          properties: {
            title: {
              id: "title",
              type: "title",
              title: [{ type: "text", plain_text: "Launch notes" }],
            },
          },
        });
      },
    ),
  );
}

function configureNotionDatabaseMock(): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/databases/:databaseId",
      ({ request, params }) => {
        expect(params.databaseId).toBe(NOTION_DATABASE_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "database",
          id: NOTION_DATABASE_ID,
          url: NOTION_DATABASE_URL,
          title: [{ plain_text: "Bug Bash" }],
          data_sources: [{ id: NOTION_DATA_SOURCE_ID, name: "Bug Bash" }],
        });
      },
    ),
    http.get(
      "https://api.notion.com/v1/data_sources/:dataSourceId",
      ({ request, params }) => {
        expect(params.dataSourceId).toBe(NOTION_DATA_SOURCE_ID);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "data_source",
          id: NOTION_DATA_SOURCE_ID,
          name: "Bug Bash",
          url: NOTION_DATA_SOURCE_URL,
          parent: {
            type: "database_id",
            database_id: NOTION_DATABASE_ID,
          },
        });
      },
    ),
  );
}

function notionSignature(rawBody: string): string {
  return `sha256=${createHmac("sha256", NOTION_WEBHOOK_TOKEN)
    .update(rawBody)
    .digest("hex")}`;
}

function notionPageEvent(args: {
  readonly id: string;
  readonly type:
    | "page.created"
    | "page.content_updated"
    | "page.properties_updated";
  readonly timestamp: string;
  readonly pageId?: string;
  readonly parent?: {
    readonly id?: string;
    readonly type?: string;
    readonly data_source_id?: string;
  };
}): Record<string, unknown> {
  return {
    id: args.id,
    timestamp: args.timestamp,
    workspace_id: NOTION_WORKSPACE_ID,
    workspace_name: "Zero Test Workspace",
    subscription_id: NOTION_SUBSCRIPTION_ID,
    integration_id: NOTION_INTEGRATION_ID,
    type: args.type,
    authors: [{ id: NOTION_AUTHOR_ID, type: "person" }],
    attempt_number: 1,
    entity: { id: args.pageId ?? NOTION_CHILD_PAGE_ID, type: "page" },
    data: {
      parent: args.parent ?? { id: NOTION_PARENT_PAGE_ID, type: "page" },
    },
  };
}

async function postNotionWebhook(args: {
  readonly rawBody: string;
  readonly signature?: string;
}): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await createApp({ signal: context.signal }).request(
    "/api/webhooks/notion",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.signature ? { "X-Notion-Signature": args.signature } : {}),
      },
      body: args.rawBody,
    },
  );
  return { status: response.status, body: await response.json() };
}

async function executeDueWorkflowTriggers(): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await createApp({ signal: context.signal }).request(
    CRON_EXECUTE_WORKFLOW_TRIGGERS_PATH,
    { headers: { authorization: `Bearer ${CRON_SECRET}` } },
  );
  return { status: response.status, body: await response.json() };
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => {
    return typeof item === "object" && item !== null && !Array.isArray(item);
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function notionEventContextFromPrompt(
  appendSystemPrompt: string,
): Record<string, unknown> {
  const marker = "# Notion event\n";
  const markerIndex = appendSystemPrompt.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const parsed: unknown = JSON.parse(
    appendSystemPrompt.slice(markerIndex + marker.length),
  );
  return record(parsed, "Notion event context");
}

describe("POST /api/webhooks/notion", () => {
  const track = createFixtureTracker<WorkflowsFixture>(async (fixture) => {
    await deleteFeatureSwitchesForUser(context, fixture);
    await workflowTriggerStateAction({
      action: "delete-scenario",
      org_id: fixture.orgId,
    });
  });

  async function setupFixture(): Promise<{
    readonly fixture: WorkflowsFixture;
    readonly workflowId: string;
  }> {
    const seeded = await workflowTriggerStateAction({
      action: "seed-scenario",
      workflow_name: WORKFLOW_NAME,
      agent_name: "notion-webhook-agent",
    });
    const rawFixture = seeded.fixture as {
      readonly org_id: string;
      readonly user_id: string;
      readonly workflow_id: string;
    };
    const fixture = await track(
      Promise.resolve({
        orgId: rawFixture.org_id,
        userId: rawFixture.user_id,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    return { fixture, workflowId: rawFixture.workflow_id };
  }

  it("verifies, signs, de-duplicates, and refreshes pending child page events", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionParentPageMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-child-page-created"
    ) {
      throw new Error("Expected a Notion child page trigger");
    }

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "verification",
        pending: 0,
        refreshed: 0,
        duplicates: 0,
      },
    });
    const secretState = await workflowTriggerStateAction({
      action: "get-notion-webhook-secret",
    });
    expect(secretState.secrets).toHaveLength(1);

    const replacement = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: "attacker-token" }),
    });
    expect(replacement).toStrictEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
    const unchangedSecretState = await workflowTriggerStateAction({
      action: "get-notion-webhook-secret",
    });
    expect(unchangedSecretState.secrets).toHaveLength(1);

    const createdRaw = JSON.stringify(
      notionPageEvent({
        id: "77777777-7777-4777-8777-777777777777",
        type: "page.created",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    );
    const first = await postNotionWebhook({
      rawBody: createdRaw,
      signature: notionSignature(createdRaw),
    });
    expect(first).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    const firstPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(firstPendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: created.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "page",
        scopeId: NOTION_PARENT_PAGE_ID,
        status: "pending",
        runAfter: "2026-07-06T12:15:00.000Z",
        latestNotionEventId: "77777777-7777-4777-8777-777777777777",
        attempts: 0,
        skipReason: null,
      }),
    ]);

    const updateRaw = JSON.stringify(
      notionPageEvent({
        id: "88888888-8888-4888-8888-888888888888",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:05:00.000Z",
      }),
    );
    const update = await postNotionWebhook({
      rawBody: updateRaw,
      signature: notionSignature(updateRaw),
    });
    expect(update).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 1,
        duplicates: 0,
      },
    });

    const refreshedPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(refreshedPendingState.events).toStrictEqual([
      expect.objectContaining({
        status: "pending",
        runAfter: "2026-07-06T12:20:00.000Z",
        latestNotionEventId: "88888888-8888-4888-8888-888888888888",
      }),
    ]);

    const duplicate = await postNotionWebhook({
      rawBody: updateRaw,
      signature: notionSignature(updateRaw),
    });
    expect(duplicate).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 0,
        duplicates: 1,
      },
    });
  });

  it("enqueues and refreshes pending database item events", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionDatabaseMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-database-item-created"
    ) {
      throw new Error("Expected a Notion database item trigger");
    }

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification.status).toBe(200);

    const createdRaw = JSON.stringify(
      notionPageEvent({
        id: "99999999-9999-4999-8999-999999999999",
        type: "page.created",
        timestamp: "2026-07-06T12:00:00.000Z",
        parent: {
          id: NOTION_DATABASE_ID,
          data_source_id: NOTION_DATA_SOURCE_ID,
        },
      }),
    );
    const first = await postNotionWebhook({
      rawBody: createdRaw,
      signature: notionSignature(createdRaw),
    });
    expect(first).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    const firstPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(firstPendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: created.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "data_source",
        scopeId: NOTION_DATA_SOURCE_ID,
        status: "pending",
        runAfter: "2026-07-06T12:15:00.000Z",
        latestNotionEventId: "99999999-9999-4999-8999-999999999999",
        attempts: 0,
        skipReason: null,
      }),
    ]);

    const updateRaw = JSON.stringify(
      notionPageEvent({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:05:00.000Z",
        parent: { id: NOTION_DATA_SOURCE_ID, type: "data_source" },
      }),
    );
    const update = await postNotionWebhook({
      rawBody: updateRaw,
      signature: notionSignature(updateRaw),
    });
    expect(update).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 1,
        duplicates: 0,
      },
    });

    const refreshedPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(refreshedPendingState.events).toStrictEqual([
      expect.objectContaining({
        status: "pending",
        runAfter: "2026-07-06T12:20:00.000Z",
        latestNotionEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ]);
  });

  it("enqueues and debounces page content updated events for a page scope", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionChildPageMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_CHILD_PAGE_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated trigger");
    }

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification.status).toBe(200);

    const contentRaw = JSON.stringify(
      notionPageEvent({
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    );
    const first = await postNotionWebhook({
      rawBody: contentRaw,
      signature: notionSignature(contentRaw),
    });
    expect(first).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    const firstPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(firstPendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: created.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "page",
        scopeId: NOTION_CHILD_PAGE_ID,
        eventFamily: "page_content_updated",
        status: "pending",
        runAfter: "2026-07-06T12:15:00.000Z",
        latestNotionEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        latestEventContext: {
          workspaceId: NOTION_WORKSPACE_ID,
          workspaceName: "Zero Test Workspace",
          authors: [{ id: NOTION_AUTHOR_ID, type: "person" }],
          attemptNumber: 1,
        },
      }),
    ]);

    const propertiesRaw = JSON.stringify(
      notionPageEvent({
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        type: "page.properties_updated",
        timestamp: "2026-07-06T12:05:00.000Z",
      }),
    );
    const properties = await postNotionWebhook({
      rawBody: propertiesRaw,
      signature: notionSignature(propertiesRaw),
    });
    expect(properties).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 0,
        duplicates: 0,
      },
    });
    const unchangedPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(unchangedPendingState.events).toStrictEqual([
      expect.objectContaining({
        runAfter: "2026-07-06T12:15:00.000Z",
        latestNotionEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ]);

    const secondContentRaw = JSON.stringify(
      notionPageEvent({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:10:00.000Z",
      }),
    );
    const second = await postNotionWebhook({
      rawBody: secondContentRaw,
      signature: notionSignature(secondContentRaw),
    });
    expect(second).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 1,
        duplicates: 0,
      },
    });
    const refreshedPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(refreshedPendingState.events).toStrictEqual([
      expect.objectContaining({
        runAfter: "2026-07-06T12:25:00.000Z",
        latestNotionEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      }),
    ]);
  });

  it("executes due page content updated events with the latest page context", async () => {
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
    mockEnv("CRON_SECRET", CRON_SECRET);
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionChildPageMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_CHILD_PAGE_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated trigger");
    }

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification.status).toBe(200);

    const contentRaw = JSON.stringify(
      notionPageEvent({
        id: "babababa-baba-4bab-8bab-babababababa",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    );
    const enqueued = await postNotionWebhook({
      rawBody: contentRaw,
      signature: notionSignature(contentRaw),
    });
    expect(enqueued).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    configureNotionChildPageMock(undefined, {
      title: "Launch notes v2",
      lastEditedTime: "2026-07-06T12:16:00.000Z",
      extraProperties: {
        Status: {
          id: "status",
          type: "select",
          select: { name: "In review", color: "yellow" },
        },
      },
    });
    mockNow(new Date("2026-07-06T12:20:00.000Z"));

    const executed = await executeDueWorkflowTriggers();
    expect(executed).toStrictEqual({
      status: 200,
      body: { success: true, executed: 1, skipped: 0 },
    });

    const runState = await workflowTriggerStateAction({
      action: "get-run-state",
      trigger_id: created.body.id,
    });
    const runs = records(runState.runs);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.triggerSource).toBe("workflow-event");
    expect(run.triggerBrief).toBe(
      'Notion page content updated "Launch notes v2" in Launch notes v2',
    );

    const agentRun = record(runState.run, "agent run");
    const appendSystemPrompt = agentRun.appendSystemPrompt;
    if (typeof appendSystemPrompt !== "string") {
      throw new Error("Expected appendSystemPrompt to be persisted");
    }
    const eventContext = notionEventContextFromPrompt(appendSystemPrompt);
    const page = record(eventContext.page, "Notion page");
    const properties = record(page.properties, "Notion page properties");
    expect(eventContext).toMatchObject({
      event: "page_content_updated",
      page: {
        id: NOTION_CHILD_PAGE_ID,
        title: "Launch notes v2",
        url: NOTION_CHILD_PAGE_URL,
        lastEditedTime: "2026-07-06T12:16:00.000Z",
      },
      latestEventContext: {
        workspaceName: "Zero Test Workspace",
        attemptNumber: 1,
      },
    });
    expect(record(properties.Status, "Status property")).toMatchObject({
      type: "select",
      select: { name: "In review" },
    });
    expect(eventContext).not.toHaveProperty("body");
    expect(eventContext).not.toHaveProperty("content");
    expect(page).not.toHaveProperty("body");
    expect(page).not.toHaveProperty("content");

    const pendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(pendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: created.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "page",
        scopeId: NOTION_CHILD_PAGE_ID,
        eventFamily: "page_content_updated",
        status: "processed",
        latestNotionEventId: "babababa-baba-4bab-8bab-babababababa",
        skipReason: null,
      }),
    ]);
  });

  it("enqueues page content updated events for a database scope", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionDatabaseMock();

    const created = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            databaseUrl: NOTION_DATABASE_URL,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated trigger");
    }

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification.status).toBe(200);

    const contentRaw = JSON.stringify(
      notionPageEvent({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:00:00.000Z",
        parent: { id: NOTION_DATA_SOURCE_ID, type: "data_source" },
      }),
    );
    const first = await postNotionWebhook({
      rawBody: contentRaw,
      signature: notionSignature(contentRaw),
    });
    expect(first).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    const pendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: created.body.id,
    });
    expect(pendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: created.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "data_source",
        scopeId: NOTION_DATA_SOURCE_ID,
        eventFamily: "page_content_updated",
        status: "pending",
        runAfter: "2026-07-06T12:15:00.000Z",
        latestNotionEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }),
    ]);
  });

  it("enqueues content updated events independently from pending create events", async () => {
    const { fixture, workflowId } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);
    await seedNotionConnector(fixture);
    configureNotionParentAndChildPageMock();

    const childTrigger = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: NOTION_PARENT_PAGE_URL,
          },
        },
      }),
      [201],
    );
    const contentTrigger = await accept(
      triggersClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: NOTION_CHILD_PAGE_URL,
          },
        },
      }),
      [201],
    );

    const verification = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: NOTION_WEBHOOK_TOKEN }),
    });
    expect(verification.status).toBe(200);

    const createdRaw = JSON.stringify(
      notionPageEvent({
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        type: "page.created",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    );
    const created = await postNotionWebhook({
      rawBody: createdRaw,
      signature: notionSignature(createdRaw),
    });
    expect(created).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 0,
        duplicates: 0,
      },
    });

    const contentRaw = JSON.stringify(
      notionPageEvent({
        id: "abababab-abab-4bab-8bab-abababababab",
        type: "page.content_updated",
        timestamp: "2026-07-06T12:05:00.000Z",
      }),
    );
    const content = await postNotionWebhook({
      rawBody: contentRaw,
      signature: notionSignature(contentRaw),
    });
    expect(content).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 1,
        refreshed: 1,
        duplicates: 0,
      },
    });

    const childPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: childTrigger.body.id,
    });
    expect(childPendingState.events).toStrictEqual([
      expect.objectContaining({
        eventFamily: "new_child_page",
        runAfter: "2026-07-06T12:20:00.000Z",
        latestNotionEventId: "abababab-abab-4bab-8bab-abababababab",
      }),
    ]);
    const contentPendingState = await workflowTriggerStateAction({
      action: "get-notion-pending-events",
      trigger_id: contentTrigger.body.id,
    });
    expect(contentPendingState.events).toStrictEqual([
      expect.objectContaining({
        triggerId: contentTrigger.body.id,
        pageId: NOTION_CHILD_PAGE_ID,
        scopeType: "page",
        scopeId: NOTION_CHILD_PAGE_ID,
        eventFamily: "page_content_updated",
        status: "pending",
        runAfter: "2026-07-06T12:20:00.000Z",
        latestNotionEventId: "abababab-abab-4bab-8bab-abababababab",
      }),
    ]);
  });

  it("rejects signed events before Notion verification has configured a token", async () => {
    const { fixture } = await setupFixture();
    await enableNotionWorkflowTriggers(fixture);

    const rawBody = JSON.stringify(
      notionPageEvent({
        id: randomUUID(),
        type: "page.created",
        timestamp: "2026-07-06T12:00:00.000Z",
      }),
    );
    const response = await postNotionWebhook({
      rawBody,
      signature: notionSignature(rawBody),
    });

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "Notion webhook verification token is not configured",
    });
  });
});
