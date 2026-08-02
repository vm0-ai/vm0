import { createHmac, randomUUID } from "node:crypto";

import { testWorkflowAutomationExecutionContract } from "@vm0/api-contracts/contracts/test-workflow-automation-execution";
import { zeroWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { resetNotionWebhookVerification } from "../../../test-fixtures/workflow-notion";
import type { ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWorkflowsBddApi,
  mockNotionConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { chatEventAutomationPart } from "./helpers/chat-event";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { testWorkflowAutomationExecutionRoutes } from "../test-workflow-automation-execution";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const wf = createWorkflowsBddApi(context);
const runsApi = createRunsApi(context);
const WORKFLOW_NAME = "notion-webhook-workflow";
const NOTION_WEBHOOK_TOKEN = "notion-webhook-verification-token";
const NOTION_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTION_SUBSCRIPTION_ID = "44444444-4444-4444-8444-444444444444";
const NOTION_INTEGRATION_ID = "55555555-5555-4555-8555-555555555555";
const NOTION_AUTHOR_ID = "66666666-6666-4666-8666-666666666666";

interface WorkflowsFixture {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * Per-test Notion entity ids. The webhook fans out to every automation in the
 * database watching the same Notion page, so ids must be unique per test to
 * stay isolated on the shared persistent database.
 */
interface NotionEntities {
  readonly parentPageId: string;
  readonly childPageId: string;
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly parentPageUrl: string;
  readonly childPageUrl: string;
  readonly databaseUrl: string;
  readonly dataSourceUrl: string;
}

function newNotionEntities(): NotionEntities {
  const parentPageId = randomUUID();
  const childPageId = randomUUID();
  const databaseId = randomUUID();
  const dataSourceId = randomUUID();
  const compact = (id: string) => {
    return id.replaceAll("-", "");
  };
  return {
    parentPageId,
    childPageId,
    databaseId,
    dataSourceId,
    parentPageUrl: `https://www.notion.so/Roadmap-${compact(parentPageId)}`,
    childPageUrl: `https://www.notion.so/Launch-notes-${compact(childPageId)}`,
    databaseUrl: `https://www.notion.so/${compact(databaseId)}?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa&source=copy_link`,
    dataSourceUrl: `https://www.notion.so/Bug-Bash-${compact(dataSourceId)}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function automationsClient() {
  return setupApp({ context })(zeroWorkflowAutomationsContract);
}

function workflowAutomationExecutionClient() {
  return setupApp({
    context,
    routes: testWorkflowAutomationExecutionRoutes,
  })(testWorkflowAutomationExecutionContract);
}

async function enableNotionWorkflowAutomations(
  fixture: WorkflowsFixture,
): Promise<void> {
  await updateFeatureSwitchesForUser(context, fixture, {
    [FeatureSwitchKey.NotionWorkflowAutomations]: true,
  });
}

function configureNotionParentPageMock(entities: NotionEntities): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(params.pageId).toBe(entities.parentPageId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "page",
          id: entities.parentPageId,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time: "2026-07-01T00:00:00.000Z",
          archived: false,
          in_trash: false,
          url: entities.parentPageUrl,
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
  entities: NotionEntities,
  parent?:
    | { readonly type: "page_id"; readonly page_id: string }
    | {
        readonly type: "data_source_id";
        readonly data_source_id: string;
        readonly database_id?: string;
      },
  options: {
    readonly title?: string;
    readonly lastEditedTime?: string;
    readonly extraProperties?: Record<string, unknown>;
  } = {},
): void {
  const title = options.title ?? "Launch notes";
  const resolvedParent = parent ?? {
    type: "page_id" as const,
    page_id: entities.parentPageId,
  };
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(params.pageId).toBe(entities.childPageId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "page",
          id: entities.childPageId,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time:
            options.lastEditedTime ?? "2026-07-06T12:00:00.000Z",
          archived: false,
          in_trash: false,
          url: entities.childPageUrl,
          parent: resolvedParent,
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

function configureNotionParentAndChildPageMock(entities: NotionEntities): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/pages/:pageId",
      ({ request, params }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        if (params.pageId === entities.parentPageId) {
          return HttpResponse.json({
            object: "page",
            id: entities.parentPageId,
            created_time: "2026-07-01T00:00:00.000Z",
            last_edited_time: "2026-07-01T00:00:00.000Z",
            archived: false,
            in_trash: false,
            url: entities.parentPageUrl,
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
        expect(params.pageId).toBe(entities.childPageId);
        return HttpResponse.json({
          object: "page",
          id: entities.childPageId,
          created_time: "2026-07-01T00:00:00.000Z",
          last_edited_time: "2026-07-06T12:00:00.000Z",
          archived: false,
          in_trash: false,
          url: entities.childPageUrl,
          parent: { type: "page_id", page_id: entities.parentPageId },
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

function configureNotionDatabaseMock(entities: NotionEntities): void {
  server.use(
    http.get(
      "https://api.notion.com/v1/databases/:databaseId",
      ({ request, params }) => {
        expect(params.databaseId).toBe(entities.databaseId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "database",
          id: entities.databaseId,
          url: entities.databaseUrl,
          title: [{ plain_text: "Bug Bash" }],
          data_sources: [{ id: entities.dataSourceId, name: "Bug Bash" }],
        });
      },
    ),
    http.get(
      "https://api.notion.com/v1/data_sources/:dataSourceId",
      ({ request, params }) => {
        expect(params.dataSourceId).toBe(entities.dataSourceId);
        expect(request.headers.get("authorization")).toBe(
          "Bearer notion-access-token",
        );
        expect(request.headers.get("notion-version")).toBe("2026-03-11");
        return HttpResponse.json({
          object: "data_source",
          id: entities.dataSourceId,
          name: "Bug Bash",
          url: entities.dataSourceUrl,
          parent: {
            type: "database_id",
            database_id: entities.databaseId,
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
  readonly entities: NotionEntities;
  readonly type: string;
  readonly timestamp: string;
  readonly pageId?: string;
  readonly parent?: {
    readonly id?: string;
    readonly type?: string;
    readonly data_source_id?: string;
  };
}): { readonly id: string; readonly rawBody: string } {
  const id = randomUUID();
  return {
    id,
    rawBody: JSON.stringify({
      id,
      timestamp: args.timestamp,
      workspace_id: NOTION_WORKSPACE_ID,
      workspace_name: "Zero Test Workspace",
      subscription_id: NOTION_SUBSCRIPTION_ID,
      integration_id: NOTION_INTEGRATION_ID,
      type: args.type,
      authors: [{ id: NOTION_AUTHOR_ID, type: "person" }],
      attempt_number: 1,
      entity: {
        id: args.pageId ?? args.entities.childPageId,
        type: "page",
      },
      data: {
        parent: args.parent ?? {
          id: args.entities.parentPageId,
          type: "page",
        },
      },
    }),
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

/**
 * Runs the Notion verification handshake from a clean slate. Verification is
 * a global one-shot, so the pre-verification state is constructed through the
 * narrow fixture before the public handshake request.
 */
async function verifyNotionWebhook(): Promise<void> {
  await resetNotionWebhookVerification();
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
}

async function executeDueWorkflowAutomations(automationId: string) {
  return await accept(
    workflowAutomationExecutionClient().execute({
      body: { automation_id: automationId },
    }),
    [200],
  );
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
  const marker = "# This run's event\n";
  const markerIndex = appendSystemPrompt.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  const parsed: unknown = JSON.parse(
    appendSystemPrompt.slice(markerIndex + marker.length),
  );
  return record(parsed, "Notion event context");
}

describe("POST /api/webhooks/notion", () => {
  async function setupFixture(): Promise<{
    readonly fixture: WorkflowsFixture;
    readonly actor: ApiTestUser;
    readonly workflowId: string;
    readonly entities: NotionEntities;
  }> {
    const { actor } = await wf.setupWorkflowOrg();
    if (!actor.orgId) {
      throw new Error("Expected an org-scoped workflow actor");
    }
    const agent = await wf.createAgent(actor, {
      displayName: "Notion Webhook Agent",
    });
    const workflowId = await wf.createWorkflow(actor, {
      agentId: agent.agentId,
      name: WORKFLOW_NAME,
    });
    const fixture = { orgId: actor.orgId, userId: actor.userId };
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");
    context.mocks.s3.send.mockResolvedValue({});
    return { fixture, actor, workflowId, entities: newNotionEntities() };
  }

  async function connectNotion(scenario: {
    readonly fixture: WorkflowsFixture;
    readonly actor: ApiTestUser;
  }): Promise<void> {
    mockNotionConnectorOAuth();
    await wf.connectConnector(scenario.actor, "notion");
    mocks.clerk.session(
      scenario.fixture.userId,
      scenario.fixture.orgId,
      "org:member",
    );
  }

  it("acknowledges unsupported and schema-invalid signed events", async () => {
    const entities = newNotionEntities();
    await verifyNotionWebhook();

    const unsupportedEvent = notionPageEvent({
      entities,
      type: "page.moved",
      timestamp: "2026-07-13T04:00:00.000Z",
    });
    const unsupportedResponse = {
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 0,
        duplicates: 0,
      },
    };
    await expect(
      postNotionWebhook({
        rawBody: unsupportedEvent.rawBody,
        signature: notionSignature(unsupportedEvent.rawBody),
      }),
    ).resolves.toStrictEqual(unsupportedResponse);
    await expect(
      postNotionWebhook({
        rawBody: unsupportedEvent.rawBody,
        signature: notionSignature(unsupportedEvent.rawBody),
      }),
    ).resolves.toStrictEqual(unsupportedResponse);

    const invalidEvent = notionPageEvent({
      entities,
      type: "page.created",
      timestamp: "not-a-timestamp",
    });
    await expect(
      postNotionWebhook({
        rawBody: invalidEvent.rawBody,
        signature: notionSignature(invalidEvent.rawBody),
      }),
    ).resolves.toStrictEqual(unsupportedResponse);
    await expect(
      postNotionWebhook({
        rawBody: invalidEvent.rawBody,
        signature: notionSignature(invalidEvent.rawBody),
      }),
    ).resolves.toStrictEqual(unsupportedResponse);
  });

  it("rejects invalid JSON and invalid signatures", async () => {
    await expect(postNotionWebhook({ rawBody: "{" })).resolves.toStrictEqual({
      status: 400,
      body: { error: "Invalid Notion webhook payload" },
    });

    const event = notionPageEvent({
      entities: newNotionEntities(),
      type: "page.created",
      timestamp: "2026-07-13T04:00:00.000Z",
    });
    await verifyNotionWebhook();
    await expect(
      postNotionWebhook({
        rawBody: event.rawBody,
        signature: "sha256=invalid",
      }),
    ).resolves.toStrictEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });
  });

  it("verifies, signs, de-duplicates, and refreshes pending child page events", async () => {
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionParentPageMock(entities);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: entities.parentPageUrl,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-child-page-created"
    ) {
      throw new Error("Expected a Notion child page automation");
    }

    await verifyNotionWebhook();

    // A replacement verification while a token is active is rejected, so the
    // original token keeps validating signed deliveries below.
    const replacement = await postNotionWebhook({
      rawBody: JSON.stringify({ verification_token: "attacker-token" }),
    });
    expect(replacement).toStrictEqual({
      status: 401,
      body: { error: "Unauthorized" },
    });

    const createdEvent = notionPageEvent({
      entities,
      type: "page.created",
      timestamp: "2026-07-06T12:00:00.000Z",
    });
    const first = await postNotionWebhook({
      rawBody: createdEvent.rawBody,
      signature: notionSignature(createdEvent.rawBody),
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

    const updateEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:05:00.000Z",
    });
    const update = await postNotionWebhook({
      rawBody: updateEvent.rawBody,
      signature: notionSignature(updateEvent.rawBody),
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

    const duplicate = await postNotionWebhook({
      rawBody: updateEvent.rawBody,
      signature: notionSignature(updateEvent.rawBody),
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
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionDatabaseMock(entities);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: entities.databaseUrl,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-database-item-created"
    ) {
      throw new Error("Expected a Notion database item automation");
    }

    await verifyNotionWebhook();

    // Notion also delivers data-source children with a database parent id
    // plus a data_source_id field (no parent type) — both shapes must match
    // the data-source automation.
    const createdEvent = notionPageEvent({
      entities,
      type: "page.created",
      timestamp: "2026-07-06T12:00:00.000Z",
      parent: {
        id: entities.databaseId,
        data_source_id: entities.dataSourceId,
      },
    });
    const first = await postNotionWebhook({
      rawBody: createdEvent.rawBody,
      signature: notionSignature(createdEvent.rawBody),
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

    const updateEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:05:00.000Z",
      parent: { id: entities.dataSourceId, type: "data_source" },
    });
    const update = await postNotionWebhook({
      rawBody: updateEvent.rawBody,
      signature: notionSignature(updateEvent.rawBody),
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
  });

  it("enqueues and debounces page content updated events for a page scope", async () => {
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionChildPageMock(entities);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: entities.childPageUrl,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated automation");
    }

    await verifyNotionWebhook();

    const contentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:00:00.000Z",
    });
    const first = await postNotionWebhook({
      rawBody: contentEvent.rawBody,
      signature: notionSignature(contentEvent.rawBody),
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

    // A properties-only update neither enqueues nor refreshes the pending
    // content event.
    const propertiesEvent = notionPageEvent({
      entities,
      type: "page.properties_updated",
      timestamp: "2026-07-06T12:05:00.000Z",
    });
    const properties = await postNotionWebhook({
      rawBody: propertiesEvent.rawBody,
      signature: notionSignature(propertiesEvent.rawBody),
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

    // A later content update refreshes the debounce window instead of adding
    // a second pending event.
    const secondContentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:10:00.000Z",
    });
    const second = await postNotionWebhook({
      rawBody: secondContentEvent.rawBody,
      signature: notionSignature(secondContentEvent.rawBody),
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
  });

  it("executes due page content updated events with the latest page context", async () => {
    const runnerGroup = runsApi.configureRunnerGroup();
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionChildPageMock(entities);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: entities.childPageUrl,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated automation");
    }
    const threadId = created.body.chatThreadId;
    if (!threadId) {
      throw new Error("Expected the Notion automation to bind a chat thread");
    }

    await verifyNotionWebhook();

    const contentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:00:00.000Z",
    });
    const enqueued = await postNotionWebhook({
      rawBody: contentEvent.rawBody,
      signature: notionSignature(contentEvent.rawBody),
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

    configureNotionChildPageMock(entities, undefined, {
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

    const executed = await executeDueWorkflowAutomations(created.body.id);
    expect(executed.body).toStrictEqual({
      success: true,
      executed: 1,
      skipped: 0,
    });

    // The run landed in the automation's bound chat thread with the friendly
    // Notion brief, linked to the created run.
    const messages = await wf.readThreadEvents(threadId);
    const workflowMessage = messages.find((message) => {
      return (
        message.eventType === "input.prompt" &&
        chatEventAutomationPart(message)?.workflowName === WORKFLOW_NAME
      );
    });
    if (!workflowMessage?.runId) {
      throw new Error("Expected a dispatched Notion workflow run message");
    }
    expect(chatEventAutomationPart(workflowMessage)?.automationBrief).toBe(
      'Notion page content updated "Launch notes v2" in Launch notes v2',
    );

    // The runner claim exposes the persisted event context: latest page
    // title, properties, and no page body/content.
    await runsApi.heartbeatRunner(runnerGroup);
    const claim = await runsApi.claimRunnerJob(workflowMessage.runId);
    const appendSystemPrompt = claim.appendSystemPrompt;
    if (typeof appendSystemPrompt !== "string") {
      throw new Error("Expected appendSystemPrompt on the claimed run");
    }
    const eventContext = notionEventContextFromPrompt(appendSystemPrompt);
    const page = record(eventContext.page, "Notion page");
    const properties = record(page.properties, "Notion page properties");
    expect(eventContext).toMatchObject({
      event: "page_content_updated",
      page: {
        id: entities.childPageId,
        title: "Launch notes v2",
        url: entities.childPageUrl,
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
  });

  it("enqueues page content updated events for a database scope", async () => {
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionDatabaseMock(entities);

    const created = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            databaseUrl: entities.databaseUrl,
          },
        },
      }),
      [201],
    );
    if (
      created.body.kind !== "event" ||
      created.body.eventType !== "notion-page-content-updated"
    ) {
      throw new Error("Expected a Notion page content updated automation");
    }

    await verifyNotionWebhook();

    const contentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:00:00.000Z",
      parent: { id: entities.dataSourceId, type: "data_source" },
    });
    const first = await postNotionWebhook({
      rawBody: contentEvent.rawBody,
      signature: notionSignature(contentEvent.rawBody),
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
  });

  it("suppresses content updated events while child page creation is pending", async () => {
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionParentAndChildPageMock(entities);

    const childAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-child-page-created",
          eventConfig: {
            provider: "notion",
            event: "child_page_created",
            parentPageUrl: entities.parentPageUrl,
          },
        },
      }),
      [201],
    );
    const contentAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            pageUrl: entities.childPageUrl,
          },
        },
      }),
      [201],
    );
    expect(childAutomation.body.id).not.toBe(contentAutomation.body.id);

    await verifyNotionWebhook();

    const createdEvent = notionPageEvent({
      entities,
      type: "page.created",
      timestamp: "2026-07-06T12:00:00.000Z",
    });
    const created = await postNotionWebhook({
      rawBody: createdEvent.rawBody,
      signature: notionSignature(createdEvent.rawBody),
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

    // The content update only refreshes the child-page automation's pending event.
    const contentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:05:00.000Z",
    });
    const content = await postNotionWebhook({
      rawBody: contentEvent.rawBody,
      signature: notionSignature(contentEvent.rawBody),
    });
    expect(content).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 1,
        duplicates: 0,
      },
    });
  });

  it("suppresses content updated events while database item creation is pending", async () => {
    const scenario = await setupFixture();
    const { fixture, workflowId, entities } = scenario;
    await enableNotionWorkflowAutomations(fixture);
    await connectNotion(scenario);
    configureNotionDatabaseMock(entities);

    const databaseAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-database-item-created",
          eventConfig: {
            provider: "notion",
            event: "database_item_created",
            databaseUrl: entities.databaseUrl,
          },
        },
      }),
      [201],
    );
    const contentAutomation = await accept(
      automationsClient().create({
        headers: authHeaders(),
        params: { workflowId },
        body: {
          kind: "event",
          eventType: "notion-page-content-updated",
          eventConfig: {
            provider: "notion",
            event: "page_content_updated",
            databaseUrl: entities.databaseUrl,
          },
        },
      }),
      [201],
    );
    expect(databaseAutomation.body.id).not.toBe(contentAutomation.body.id);

    await verifyNotionWebhook();

    const createdEvent = notionPageEvent({
      entities,
      type: "page.created",
      timestamp: "2026-07-06T12:00:00.000Z",
      parent: {
        id: entities.databaseId,
        data_source_id: entities.dataSourceId,
      },
    });
    const created = await postNotionWebhook({
      rawBody: createdEvent.rawBody,
      signature: notionSignature(createdEvent.rawBody),
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

    const contentEvent = notionPageEvent({
      entities,
      type: "page.content_updated",
      timestamp: "2026-07-06T12:05:00.000Z",
      parent: { id: entities.dataSourceId, type: "data_source" },
    });
    const content = await postNotionWebhook({
      rawBody: contentEvent.rawBody,
      signature: notionSignature(contentEvent.rawBody),
    });
    expect(content).toStrictEqual({
      status: 200,
      body: {
        success: true,
        kind: "event",
        pending: 0,
        refreshed: 1,
        duplicates: 0,
      },
    });
  });
});
