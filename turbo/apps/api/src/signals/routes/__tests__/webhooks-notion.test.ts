import { createHmac, randomUUID } from "node:crypto";

import { zeroWorkflowTriggersContract } from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { HttpResponse, http } from "msw";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
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

const WORKFLOW_NAME = "notion-webhook-workflow";
const NOTION_PARENT_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_CHILD_PAGE_ID = "22222222-2222-4222-8222-222222222222";
const NOTION_DATABASE_ID = "77777777-7777-4777-8777-777777777777";
const NOTION_DATA_SOURCE_ID = "88888888-8888-4888-8888-888888888888";
const NOTION_PARENT_PAGE_URL =
  "https://www.notion.so/Roadmap-11111111111141118111111111111111";
const NOTION_DATABASE_URL =
  "https://www.notion.so/77777777777747778777777777777777?v=aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa&source=copy_link";
const NOTION_DATA_SOURCE_URL =
  "https://www.notion.so/Bug-Bash-88888888888848888888888888888888";
const NOTION_WEBHOOK_TOKEN = "notion-webhook-verification-token";
const NOTION_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const NOTION_SUBSCRIPTION_ID = "44444444-4444-4444-8444-444444444444";
const NOTION_INTEGRATION_ID = "55555555-5555-4555-8555-555555555555";
const NOTION_AUTHOR_ID = "66666666-6666-4666-8666-666666666666";

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
  readonly type: "page.created" | "page.content_updated";
  readonly timestamp: string;
  readonly parent?: { readonly id: string; readonly type: string };
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
    entity: { id: NOTION_CHILD_PAGE_ID, type: "page" },
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
        parent: { id: NOTION_DATA_SOURCE_ID, type: "data_source" },
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
