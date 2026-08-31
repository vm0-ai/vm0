import type { Locator, Page, Request, Response } from "@playwright/test";
import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { waitForActiveAgentId } from "../lib/active-agent";
import type {
  SharedWorkerRequest,
  SharedWorkerRouteRegistration,
  SharedWorkerRoutes,
} from "../lib/shared-worker-routes";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const chatEventSchemaVersionHeader = "X-Chat-Event-Schema-Version";
const composerConnectorSlugs = ["github", "slack", "asana"] as const;
const responsiveFollowupThreadId = "b0000000-0000-4000-a000-000000000734";
const modelChangeThreadId = "b0000000-0000-4000-a000-000000000735";
const imageLayoutThreadId = "b0000000-0000-4000-a000-000000000736";
const cardSpacingThreadId = "b0000000-0000-4000-a000-000000000737";
const forwardLayoutThreadId = "b0000000-0000-4000-a000-000000000738";
const forwardLayoutThreadTitle =
  "Forward composer layout with a very long thread title";
const modelPickerBoundaryModels = [
  { model: "claude-fable-5", label: "Claude Fable 5" },
  { model: "claude-opus-5", label: "Claude Opus 5" },
  { model: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { model: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { model: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
  { model: "gpt-5.6-luna", label: "GPT 5.6 Luna" },
  { model: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  { model: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
] as const;
// Card slots carry the same block margins as the paragraphs around them, and
// adjacent margins collapse into one gap.
const cardSlotGapPx = 8;
const responsiveFollowupPrompts = [
  "Draft launch copy",
  "Create a detailed presentation outline with speaker notes",
  "Generate a hero image",
] as const;

interface ConnectorCatalogStatusItem {
  readonly slug: string;
  readonly icon: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

interface ConnectorCatalogStatusResponse {
  readonly connectors: readonly ConnectorCatalogStatusItem[];
  readonly [key: string]: unknown;
}

interface ModelPickerGeometry {
  readonly clientHeight: number;
  readonly optionCount: number;
  readonly rowStep: number;
  readonly scrollHeight: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mockChatEventCursorId(seqId: number): string {
  const suffix = seqId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

async function negotiatedChatEventHeaders(
  request: Request | SharedWorkerRequest,
): Promise<Record<string, string>> {
  const version = await request.headerValue(chatEventSchemaVersionHeader);
  if (version === null) {
    throw new Error("Chat Event request is missing its schema version");
  }
  return {
    "Access-Control-Expose-Headers": chatEventSchemaVersionHeader,
    [chatEventSchemaVersionHeader]: version,
  };
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) {
        throw new Error("Deferred promise resolver is unavailable");
      }
      resolvePromise();
    },
  };
}

function isSuccessfulAgentDraftClear(response: Response): boolean {
  const request = response.request();
  if (
    !response.ok() ||
    request.method() !== "PATCH" ||
    !/^\/api\/agents\/[^/]+\/draft$/.test(new URL(response.url()).pathname)
  ) {
    return false;
  }
  const body: unknown = request.postDataJSON();
  return (
    isRecord(body) &&
    body.draftUserMessage === null &&
    body.draftAttachments === null
  );
}

async function waitForAgentDraftClear(
  page: Page,
  clearDraft: () => Promise<void>,
): Promise<void> {
  const draftCleared = page.waitForResponse(isSuccessfulAgentDraftClear);
  await clearDraft();
  await draftCleared;
}

async function navigateToMockChatThread(
  page: Page,
  threadId: string,
  events: SharedWorkerRouteRegistration,
  eventRows: SharedWorkerRouteRegistration,
): Promise<void> {
  await events.handled;
  await page.goto(new URL(`/chats/${threadId}`, appUrl).href);
  await eventRows.handled;
}

async function clearComposerEditor(editor: Locator): Promise<void> {
  await editor.press("ControlOrMeta+A");
  await editor.press("Backspace");
  await expect(editor).toHaveText("");
}

function isConnectorCatalogStatusResponse(
  value: unknown,
): value is ConnectorCatalogStatusResponse {
  if (!isRecord(value) || !Array.isArray(value.connectors)) {
    return false;
  }
  return value.connectors.every((connector) => {
    return (
      isRecord(connector) &&
      typeof connector.slug === "string" &&
      isRecord(connector.icon)
    );
  });
}

async function mockComposerConnectorState(page: Page): Promise<void> {
  const connectorSlugs = new Set<string>(composerConnectorSlugs);
  const iconUrl = new URL("/playwright/composer-connector.svg", appUrl).href;
  await page.route(iconUrl, async (route) => {
    await route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#2563eb" /></svg>',
      contentType: "image/svg+xml",
    });
  });
  await page.route("**/api/connector-catalog/discovery", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isConnectorCatalogStatusResponse(body)) {
      throw new Error("Connector catalog returned an unexpected response");
    }
    const availableSlugs = new Set(
      body.connectors.map((connector) => {
        return connector.slug;
      }),
    );
    for (const slug of connectorSlugs) {
      if (!availableSlugs.has(slug)) {
        throw new Error(`Connector catalog is missing ${slug}`);
      }
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        connectors: body.connectors.map((connector) => {
          if (!connectorSlugs.has(connector.slug)) {
            return connector;
          }
          return {
            ...connector,
            connected: true,
            connectionStatus: "connected",
            icon: { ...connector.icon, url: iconUrl },
          };
        }),
      },
    });
  });
  await page.route("**/api/agents/*/user-connectors", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: { enabledConnectorSlugs: composerConnectorSlugs },
    });
  });
}

async function enableFeatureSwitch(
  page: Page,
  key:
    | "chatForward"
    | "composerImageAnnotation"
    | "imageModelSelection"
    | "responsiveFollowupCards",
): Promise<void> {
  await page.route("**/api/feature-switches", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.effectiveSwitches)) {
      throw new Error("Feature switches returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        effectiveSwitches: {
          ...body.effectiveSwitches,
          [key]: true,
        },
      },
    });
  });
}

async function enableResponsiveFollowupCards(page: Page): Promise<void> {
  await enableFeatureSwitch(page, "responsiveFollowupCards");
}

async function enableChatForward(page: Page): Promise<void> {
  await enableFeatureSwitch(page, "chatForward");
}

async function mockUnrestrictedModelBilling(page: Page): Promise<void> {
  await page.route("**/api/billing/status", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body)) {
      throw new Error("Billing status returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        supportByok: true,
        restrictedVm0Models: false,
      },
    });
  });
}

async function mockSelectedFastModel(page: Page): Promise<void> {
  const policyId = "00000000-0000-4000-a000-000000000736";
  await page.route("**/api/feature-switches", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.effectiveSwitches)) {
      throw new Error("Feature switches returned an unexpected response");
    }
    await route.fulfill({
      response,
      json: {
        ...body,
        effectiveSwitches: {
          ...body.effectiveSwitches,
          codexFastMode: true,
        },
      },
    });
  });
  await mockUnrestrictedModelBilling(page);
  await page.route("**/api/model-policies", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        policies: [
          {
            id: policyId,
            model: "gpt-5.6-sol",
            modelLabel: "GPT 5.6 Sol",
            isDefault: true,
            defaultProviderType: "vm0",
            credentialScope: "org",
            modelProviderId: null,
            modelProviderSurfaceId: null,
            routeStatus: "valid",
            routeStatusReason: null,
            createdAt: "2026-08-12T00:00:00.000Z",
            updatedAt: "2026-08-12T00:00:00.000Z",
          },
        ],
        workspaceDefaultModel: "gpt-5.6-sol",
        workspaceDefaultPolicyId: policyId,
      },
    });
  });
  await page.route("**/api/user-model-preference", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const update: unknown = request.postDataJSON();
      if (!isRecord(update)) {
        throw new Error("Model preference update was not a record");
      }
      await route.fulfill({
        json: {
          ...update,
          updatedAt: "2026-08-12T00:00:00.000Z",
        },
      });
      return;
    }
    if (request.method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        selectedModel: "gpt-5.6-sol",
        serviceTier: "priority",
        updatedAt: "2026-08-12T00:00:00.000Z",
      },
    });
  });
}

async function mockModelPickerBoundary(page: Page): Promise<{
  showEightModels(): void;
}> {
  const policyId = (index: number) => {
    return `00000000-0000-4000-a000-${String(index + 1).padStart(12, "0")}`;
  };
  let visibleModelCount = 7;

  await enableFeatureSwitch(page, "imageModelSelection");
  await mockUnrestrictedModelBilling(page);
  await page.route("**/api/model-policies", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const policies = modelPickerBoundaryModels
      .slice(0, visibleModelCount)
      .map(({ model, label }, index) => {
        return {
          id: policyId(index),
          model,
          modelLabel: label,
          isDefault: index === 0,
          defaultProviderType: "vm0",
          credentialScope: "org",
          modelProviderId: null,
          modelProviderSurfaceId: null,
          routeStatus: "valid",
          routeStatusReason: null,
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        };
      });
    await route.fulfill({
      json: {
        policies,
        workspaceDefaultModel: modelPickerBoundaryModels[0].model,
        workspaceDefaultPolicyId: policyId(0),
      },
    });
  });
  await page.route("**/api/user-model-preference", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        selectedModel: null,
        serviceTier: null,
        updatedAt: null,
      },
    });
  });

  return {
    showEightModels: () => {
      visibleModelCount = 8;
    },
  };
}

interface MockChatThreadOptions {
  readonly agentId: Promise<string>;
  readonly createdAt: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly selectedModel: string | null;
  readonly threadId: string;
  readonly title: string;
}

interface MockChatThreadRoutes {
  readonly eventRows: SharedWorkerRouteRegistration;
  readonly events: SharedWorkerRouteRegistration;
}

function toMockChatEventRow(
  event: Readonly<Record<string, unknown>>,
  threadId: string,
): Readonly<Record<string, unknown>> {
  const payload = Object.fromEntries(
    ["content", "userMessage", "thinking", "error", "usage"].flatMap((key) => {
      const value = event[key];
      return value === undefined || value === null
        ? []
        : ([[key, value]] as const);
    }),
  );
  const runGroupId = event.runGroupId;

  return {
    id: event.id,
    chatThreadId: threadId,
    runId: event.runId ?? event.interruptsRunId ?? null,
    revokesEventId: event.revokesEventId ?? null,
    eventType: event.eventType,
    payload: Object.keys(payload).length === 0 ? null : payload,
    contextType: typeof runGroupId === "string" ? "goal" : null,
    contextId: typeof runGroupId === "string" ? runGroupId : null,
    runEventSequenceNumber: event.sequenceNumber ?? null,
    runEventId: event.runEventId ?? null,
    seqId: event.seqId,
    createdAt: event.createdAt,
  };
}

async function mockChatThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  options: MockChatThreadOptions,
): Promise<MockChatThreadRoutes> {
  const createdEventId = `d${options.threadId.slice(1)}`;
  let createdEventSeqId: number | null = null;

  sharedWorkerRoutes.route(
    (url) => url.pathname === "/api/chat-threads/snapshot",
    async (route) => {
      await route.fulfill({
        json: {
          chatThreads: [],
          latestEventId: null,
          latestSeqId: null,
        },
      });
    },
  );
  const events = sharedWorkerRoutes.route(
    (url) => url.pathname === "/api/chat-threads/events",
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const rawSinceSeqId = requestUrl.searchParams.get("sinceSeqId");
      const sinceSeqId = rawSinceSeqId === null ? 0 : Number(rawSinceSeqId);
      if (!Number.isSafeInteger(sinceSeqId) || sinceSeqId < 0) {
        throw new Error("Thread event cursor is invalid");
      }

      // Anchor the synthetic event after the worker's current cursor so cold
      // and already-cached starts reach the same thread metadata.
      createdEventSeqId ??= sinceSeqId + 1;
      const events =
        sinceSeqId < createdEventSeqId
          ? [
              {
                id: createdEventId,
                seqId: createdEventSeqId,
                kind: "created",
                chatThreadId: options.threadId,
                agentId: await options.agentId,
                title: options.title,
                selectedModel: options.selectedModel,
                serviceTier: null,
                computerUseHostId: null,
                cloudBrowserEnabled: false,
                createdAt: options.createdAt,
              },
            ]
          : [];
      await route.fulfill({ json: { events, hasMore: false } });
    },
  );
  const eventRows = sharedWorkerRoutes.route(
    (url) =>
      url.pathname === `/api/chat-threads/${options.threadId}/event-rows`,
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const sinceSeqId = Number(
        requestUrl.searchParams.get("sinceSeqId") ?? "0",
      );
      const sinceEventId = requestUrl.searchParams.get("sinceEventId");
      if (!Number.isSafeInteger(sinceSeqId) || sinceSeqId < 0) {
        throw new Error("Chat event row cursor is invalid");
      }
      if (
        (sinceSeqId === 0 && sinceEventId !== null) ||
        (sinceSeqId > 0 && sinceEventId === null)
      ) {
        throw new Error("Chat event row cursor is missing its event identity");
      }
      const rows = options.events
        .map((event) => {
          return toMockChatEventRow(event, options.threadId);
        })
        .filter((row) => {
          return typeof row.seqId === "number" && row.seqId > sinceSeqId;
        });
      const lastRow = rows.at(-1);
      const lastSeqId =
        lastRow !== undefined && typeof lastRow.seqId === "number"
          ? lastRow.seqId
          : null;
      const cursor =
        lastSeqId !== null
          ? {
              lastEventId: mockChatEventCursorId(lastSeqId),
              lastSeqId,
            }
          : sinceEventId === null
            ? { lastEventId: null, lastSeqId: 0 }
            : {
                lastEventId: sinceEventId,
                lastSeqId: sinceSeqId,
              };
      await route.fulfill({
        headers: await negotiatedChatEventHeaders(route.request()),
        json: {
          rows,
          cursor,
          hasMore: false,
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/chat-threads/${options.threadId}/draft`,
    async (route) => {
      await route.fulfill({
        json: { draftUserMessage: null, draftAttachments: null },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/chat-threads/${options.threadId}/mark-read`,
    async (route) => {
      await route.fulfill({
        json: { lastReadAt: options.createdAt, unreads: [] },
      });
    },
  );
  sharedWorkerRoutes.route(
    (url) =>
      url.pathname === `/api/chat-threads/${options.threadId}/event-snapshot`,
    async (route) => {
      await route.fulfill({
        headers: await negotiatedChatEventHeaders(route.request()),
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Not found" } },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/chat-threads/${options.threadId}`,
    async (route) => {
      await route.fulfill({
        json: {
          lastReadAt: options.createdAt,
          cancellationRecoveryPending: false,
        },
      });
    },
  );
  return { eventRows, events };
}

async function mockResponsiveFollowupThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  agentId: Promise<string>,
): Promise<MockChatThreadRoutes> {
  const createdAt = "2026-06-09T10:01:01Z";
  const runId = "run-responsive-followups";
  const events = [
    {
      id: "msg-responsive-followups-assistant",
      threadId: responsiveFollowupThreadId,
      eventType: "output.message",
      content: "The launch plan is ready.",
      runId,
      seqId: 1,
      createdAt: "2026-06-09T10:01:00Z",
    },
    {
      id: "msg-responsive-followups-completed",
      threadId: responsiveFollowupThreadId,
      eventType: "run.completed",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt,
    },
    {
      id: "msg-responsive-followups-followups",
      threadId: responsiveFollowupThreadId,
      eventType: "output.followups",
      content: JSON.stringify({
        version: 1,
        followups: responsiveFollowupPrompts.map((prompt) => {
          return { prompt, kind: "talk" };
        }),
      }),
      runId,
      seqId: 3,
      createdAt,
    },
  ];

  return await mockChatThread(page, sharedWorkerRoutes, {
    agentId,
    createdAt,
    events,
    selectedModel: null,
    threadId: responsiveFollowupThreadId,
    title: "Responsive follow-ups",
  });
}

async function mockForwardLayoutThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  agentId: Promise<string>,
): Promise<MockChatThreadRoutes> {
  const createdAt = "2026-08-13T08:00:01Z";
  const runId = "run-forward-layout";
  return await mockChatThread(page, sharedWorkerRoutes, {
    agentId,
    createdAt,
    selectedModel: null,
    threadId: forwardLayoutThreadId,
    title: forwardLayoutThreadTitle,
    events: [
      {
        id: "msg-forward-layout-assistant",
        threadId: forwardLayoutThreadId,
        eventType: "output.message",
        content: "Keep the forward composer within the modal.",
        runId,
        seqId: 1,
        createdAt: "2026-08-13T08:00:00Z",
      },
      {
        id: "msg-forward-layout-completed",
        threadId: forwardLayoutThreadId,
        eventType: "run.completed",
        content: null,
        runId,
        runLifecycleEvent: "completed",
        seqId: 2,
        createdAt,
      },
    ],
  });
}

async function mockModelChangeThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  agentId: Promise<string>,
): Promise<MockChatThreadRoutes> {
  const createdAt = "2026-08-06T09:02:01Z";
  const events = [
    {
      id: "msg-model-before-user",
      threadId: modelChangeThreadId,
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "First prompt" },
          { type: "model", selectedModel: "gpt-5.5" },
        ],
      },
      runId: "run-model-before",
      seqId: 1,
      createdAt: "2026-08-06T09:00:00Z",
    },
    {
      id: "msg-model-before-assistant",
      threadId: modelChangeThreadId,
      eventType: "output.message",
      content: "First answer",
      runId: "run-model-before",
      seqId: 2,
      createdAt: "2026-08-06T09:00:01Z",
    },
    {
      id: "msg-model-before-completed",
      threadId: modelChangeThreadId,
      eventType: "run.completed",
      content: null,
      runId: "run-model-before",
      runLifecycleEvent: "completed",
      seqId: 3,
      createdAt: "2026-08-06T09:00:02Z",
    },
    {
      id: "msg-model-current-user",
      threadId: modelChangeThreadId,
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Second prompt" },
          { type: "model", selectedModel: "claude-sonnet-4-6" },
        ],
      },
      runId: "run-model-current",
      seqId: 4,
      createdAt: "2026-08-06T09:01:00Z",
    },
    {
      id: "msg-model-current-assistant",
      threadId: modelChangeThreadId,
      eventType: "output.message",
      content: "Second answer",
      runId: "run-model-current",
      seqId: 5,
      createdAt: "2026-08-06T09:01:01Z",
    },
    {
      id: "msg-model-current-completed",
      threadId: modelChangeThreadId,
      eventType: "run.completed",
      content: null,
      runId: "run-model-current",
      runLifecycleEvent: "completed",
      seqId: 6,
      createdAt: "2026-08-06T09:01:02Z",
    },
    {
      id: "msg-model-active-user",
      threadId: modelChangeThreadId,
      eventType: "input.prompt",
      content: null,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: "Active prompt" },
          { type: "model", selectedModel: "claude-sonnet-4-6" },
        ],
      },
      runId: "run-model-active",
      seqId: 7,
      createdAt: "2026-08-06T09:02:00Z",
    },
    {
      id: "msg-model-active-thinking",
      threadId: modelChangeThreadId,
      eventType: "output.thinking",
      content: null,
      thinking: "Still working",
      runId: "run-model-active",
      seqId: 8,
      createdAt,
    },
  ];
  return await mockChatThread(page, sharedWorkerRoutes, {
    agentId,
    createdAt,
    events,
    selectedModel: "claude-opus-4-8",
    threadId: modelChangeThreadId,
    title: "Model change layout",
  });
}

async function mockCardSpacingThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  agentId: Promise<string>,
): Promise<MockChatThreadRoutes> {
  const createdAt = "2026-08-13T06:00:02Z";
  const runId = "run-card-spacing";
  const events = [
    {
      id: "msg-card-spacing-assistant",
      threadId: cardSpacingThreadId,
      eventType: "output.message",
      // Each authorization link stands alone in its own paragraph, so the body
      // parser turns both into card slots the renderer stacks back to back.
      content: [
        "Two sessions are waiting for authorization.",
        new URL("/computer-use/authorize/card-spacing-first", appUrl).href,
        new URL("/computer-use/authorize/card-spacing-second", appUrl).href,
      ].join("\n\n"),
      runId,
      seqId: 1,
      createdAt: "2026-08-13T06:00:00Z",
    },
    {
      id: "msg-card-spacing-completed",
      threadId: cardSpacingThreadId,
      eventType: "run.completed",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      seqId: 2,
      createdAt,
    },
  ];
  return await mockChatThread(page, sharedWorkerRoutes, {
    agentId,
    createdAt,
    events,
    selectedModel: null,
    threadId: cardSpacingThreadId,
    title: "Card slot spacing",
  });
}

interface DelayedImageRoutes {
  readonly assistantImageRequested: Promise<void>;
  readonly assistantImageUrl: string;
  readonly releaseImages: () => void;
  readonly userImageRequested: Promise<void>;
  readonly userImageUrl: string;
}

async function setupDelayedImageRoutes(
  page: Page,
): Promise<DelayedImageRoutes> {
  const userImageUrl = new URL("/playwright/delayed-user-image.svg", appUrl)
    .href;
  const assistantImageUrl = new URL(
    "/playwright/delayed-assistant-image.svg",
    appUrl,
  ).href;
  const userImageRequested = deferred();
  const assistantImageRequested = deferred();
  const releaseImages = deferred();
  const imageMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
      <rect width="1200" height="900" fill="#2563eb" />
    </svg>
  `;
  const routeImage = async (
    url: string,
    requested: { resolve(): void },
  ): Promise<void> => {
    await page.route(url, async (route) => {
      requested.resolve();
      await releaseImages.promise;
      await route.fulfill({ body: imageMarkup, contentType: "image/svg+xml" });
    });
  };
  await routeImage(userImageUrl, userImageRequested);
  await routeImage(assistantImageUrl, assistantImageRequested);
  await page.route("**/api/web/file-url?*", async (route) => {
    const fileId = new URL(route.request().url()).searchParams.get("file_id");
    if (fileId !== "playwright-delayed-user-image") {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { url: userImageUrl } });
  });
  return {
    assistantImageRequested: assistantImageRequested.promise,
    assistantImageUrl,
    releaseImages: releaseImages.resolve,
    userImageRequested: userImageRequested.promise,
    userImageUrl,
  };
}

async function mockDelayedImageLayoutThread(
  page: Page,
  sharedWorkerRoutes: SharedWorkerRoutes,
  agentId: Promise<string>,
  routes: DelayedImageRoutes,
): Promise<MockChatThreadRoutes> {
  await page.route(
    (url) =>
      url.pathname === `/api/chat-threads/${imageLayoutThreadId}/artifacts`,
    async (route) => {
      await route.fulfill({ json: { runs: [] } });
    },
  );
  const runId = "run-delayed-image-layout";
  return await mockChatThread(page, sharedWorkerRoutes, {
    agentId,
    createdAt: "2026-08-12T09:00:03Z",
    selectedModel: null,
    threadId: imageLayoutThreadId,
    title: "Delayed image preview layout",
    events: [
      {
        id: "msg-delayed-user-image",
        threadId: imageLayoutThreadId,
        eventType: "input.prompt",
        content: null,
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: "playwright-delayed-user-image",
              filenameSnapshot: "delayed-user-image.svg",
              contentType: "image/svg+xml",
            },
            { type: "text", text: "User image follower" },
          ],
        },
        runId,
        seqId: 1,
        createdAt: "2026-08-12T09:00:00Z",
      },
      {
        id: "msg-delayed-assistant-image",
        threadId: imageLayoutThreadId,
        eventType: "output.message",
        content: `![delayed-assistant-image.svg](${routes.assistantImageUrl})\n\nAssistant image follower`,
        runId,
        seqId: 2,
        createdAt: "2026-08-12T09:00:01Z",
      },
      {
        id: "msg-delayed-image-completed",
        threadId: imageLayoutThreadId,
        eventType: "run.completed",
        content: null,
        runId,
        runLifecycleEvent: "completed",
        seqId: 3,
        createdAt: "2026-08-12T09:00:03Z",
      },
    ],
  });
}

function delayedImagePreview(
  page: Page,
  role: "assistant" | "user",
  alt: string,
  followerText: string,
) {
  const image = page.getByAltText(alt);
  const preview = image.locator("..");
  return {
    follower: page.getByText(followerText, { exact: true }),
    image,
    message: page.locator(`[data-role="${role}"]`).filter({ has: preview }),
    preview,
  };
}

async function expectRightAlignedDivider(label: Locator): Promise<void> {
  await expect(label).toBeVisible();
  const row = label.locator("..");
  const divider = row.getByRole("separator");
  await expect(divider).toBeVisible();
  const [labelBox, dividerBox, rowBox] = await Promise.all([
    label.boundingBox(),
    divider.boundingBox(),
    row.boundingBox(),
  ]);
  if (!labelBox || !dividerBox || !rowBox) {
    throw new Error("Model change divider geometry unavailable");
  }
  const tolerance = 1;
  expect(dividerBox.x + dividerBox.width).toBeLessThanOrEqual(
    labelBox.x + tolerance,
  );
  expect(
    Math.abs(labelBox.x + labelBox.width - (rowBox.x + rowBox.width)),
  ).toBeLessThan(tolerance);
}

/** `right-2` on the checkmark, measured from the row's right edge. */
const MODEL_ROW_CHECK_INSET = 8;
/** `right-8 w-8` on the fast toggle: the column left of the check. */
const MODEL_ROW_FAST_INSET = 32;

/**
 * Every model row ends with the same checkmark column, and a row that offers
 * Codex fast mode reserves a second fixed column beside it for the toggle.
 * Both columns are reserved whether or not the row is selected, so selecting a
 * model must not move the check: it used to shift 32px left and land on the
 * far side of the toggle.
 */
async function expectModelRowColumns(page: Page): Promise<void> {
  const standardOption = page.getByRole("option", {
    name: "GPT 5.6 Sol",
    exact: true,
  });
  const fastOption = page.getByRole("option", {
    name: "GPT 5.6 Sol Fast",
    exact: true,
  });
  const selectedCheck = standardOption.locator("svg.lucide-check");
  const priceTier = standardOption.getByText(/^\$+$/);
  const row = standardOption.locator("..");
  await expect(standardOption).toBeVisible();
  await expect(fastOption).toBeVisible();
  await expect(selectedCheck).toBeVisible();
  const [fastBox, checkBox, priceTierBox, rowBox] = await Promise.all([
    fastOption.boundingBox(),
    selectedCheck.boundingBox(),
    priceTier.boundingBox(),
    row.boundingBox(),
  ]);
  if (!fastBox || !checkBox || !priceTierBox || !rowBox) {
    throw new Error("Model picker option geometry unavailable");
  }
  const tolerance = 1;
  const rowRight = rowBox.x + rowBox.width;
  const checkRight = checkBox.x + checkBox.width;
  const fastRight = fastBox.x + fastBox.width;
  // The checkmark is the element closest to the row's right edge.
  expect(rowRight - checkRight).toBeGreaterThan(0);
  expect(rowRight - checkRight).toBeLessThanOrEqual(MODEL_ROW_CHECK_INSET);
  // The fast toggle holds the next column in and never covers the check.
  expect(Math.abs(rowRight - fastRight - MODEL_ROW_FAST_INSET)).toBeLessThan(
    tolerance,
  );
  expect(fastRight).toBeLessThanOrEqual(checkBox.x + tolerance);
  // Row content stops before both columns rather than running under them.
  expect(priceTierBox.x + priceTierBox.width).toBeLessThanOrEqual(
    fastBox.x + tolerance,
  );
}

async function openModelPickerAndReadGeometry(
  page: Page,
): Promise<ModelPickerGeometry> {
  await page
    .getByRole("combobox", { name: "Claude Fable 5", exact: true })
    .click();
  const scrollContainer = page.locator('[data-slot="select-content"]');
  await expect(scrollContainer).toBeVisible();
  await expect(scrollContainer.getByRole("option").first()).toBeVisible();
  return scrollContainer.evaluate((element) => {
    const options = Array.from(
      element.querySelectorAll<HTMLElement>('[role="option"]'),
    ).filter((option) => {
      return option.getBoundingClientRect().height > 0;
    });
    const first = options[0]?.getBoundingClientRect();
    const second = options[1]?.getBoundingClientRect();
    if (!first || !second) {
      throw new Error("Model picker row geometry unavailable");
    }
    return {
      clientHeight: element.clientHeight,
      optionCount: options.length,
      rowStep: second.top - first.top,
      scrollHeight: element.scrollHeight,
    };
  });
}

async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  await expect(inner).toBeVisible();
  await expect(outer).toBeVisible();
  const innerBox = await inner.boundingBox();
  const outerBox = await outer.boundingBox();
  if (!innerBox || !outerBox) {
    throw new Error("Composer geometry unavailable");
  }
  const tolerance = 0.5;
  expect(innerBox.x).toBeGreaterThanOrEqual(outerBox.x - tolerance);
  expect(innerBox.y).toBeGreaterThanOrEqual(outerBox.y - tolerance);
  expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(
    outerBox.x + outerBox.width + tolerance,
  );
  expect(innerBox.y + innerBox.height).toBeLessThanOrEqual(
    outerBox.y + outerBox.height + tolerance,
  );
}

async function computedIconStyle(control: Locator): Promise<{
  readonly height: string;
  readonly opacity: string;
  readonly width: string;
}> {
  const icon = control.locator("svg").first();
  await expect(icon).toBeVisible();
  return icon.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      height: style.height,
      opacity: style.opacity,
      width: style.width,
    };
  });
}

interface ImagePreviewGeometry {
  readonly image: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly messageHeight: number;
  readonly preview: {
    readonly height: number;
    readonly width: number;
    readonly x: number;
    readonly y: number;
  };
  readonly previewOffsetTop: number;
  readonly followerOffsetTop: number;
  readonly border: {
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly top: number;
  };
}

async function imagePreviewGeometry({
  follower,
  image,
  message,
  preview,
}: {
  readonly follower: Locator;
  readonly image: Locator;
  readonly message: Locator;
  readonly preview: Locator;
}): Promise<ImagePreviewGeometry> {
  const [followerBox, imageBox, messageBox, previewBox, border] =
    await Promise.all([
      follower.boundingBox(),
      image.boundingBox(),
      message.boundingBox(),
      preview.boundingBox(),
      preview.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          bottom: Number.parseFloat(style.borderBottomWidth),
          left: Number.parseFloat(style.borderLeftWidth),
          right: Number.parseFloat(style.borderRightWidth),
          top: Number.parseFloat(style.borderTopWidth),
        };
      }),
    ]);
  if (!followerBox || !imageBox || !messageBox || !previewBox) {
    throw new Error("Image preview geometry unavailable");
  }
  return {
    image: imageBox,
    messageHeight: messageBox.height,
    preview: previewBox,
    previewOffsetTop: previewBox.y - messageBox.y,
    followerOffsetTop: followerBox.y - messageBox.y,
    border,
  };
}

function expectStableImagePreviewGeometry(
  before: ImagePreviewGeometry,
  after: ImagePreviewGeometry,
): void {
  const tolerance = 0.5;
  expect(Math.abs(after.preview.height - before.preview.height)).toBeLessThan(
    tolerance,
  );
  expect(Math.abs(after.messageHeight - before.messageHeight)).toBeLessThan(
    tolerance,
  );
  expect(
    Math.abs(after.previewOffsetTop - before.previewOffsetTop),
  ).toBeLessThan(tolerance);
  expect(
    Math.abs(after.followerOffsetTop - before.followerOffsetTop),
  ).toBeLessThan(tolerance);
}

function expectImageInsidePreviewBorder(geometry: ImagePreviewGeometry): void {
  const tolerance = 0.5;
  const previewRight = geometry.preview.x + geometry.preview.width;
  const previewBottom = geometry.preview.y + geometry.preview.height;
  expect(Math.min(...Object.values(geometry.border))).toBeGreaterThan(0);
  expect(geometry.image.x).toBeGreaterThanOrEqual(
    geometry.preview.x + geometry.border.left - tolerance,
  );
  expect(geometry.image.y).toBeGreaterThanOrEqual(
    geometry.preview.y + geometry.border.top - tolerance,
  );
  expect(geometry.image.x + geometry.image.width).toBeLessThanOrEqual(
    previewRight - geometry.border.right + tolerance,
  );
  expect(geometry.image.y + geometry.image.height).toBeLessThanOrEqual(
    previewBottom - geometry.border.bottom + tolerance,
  );
}

async function expectPreviewFocusVisible(preview: Locator): Promise<void> {
  await preview.press("Tab");
  await preview.focus();
  const focus = await preview.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus.focusVisible).toBe(true);
  expect(focus.outlineStyle).not.toBe("none");
  expect(focus.outlineWidth).toBeGreaterThan(0);
}

async function cardEdgeAppearance(locator: Locator) {
  return locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => {
        return animation.finished;
      }),
    );
    const style = getComputedStyle(element);
    return {
      borderWidths: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ],
      boxShadow: style.boxShadow,
    };
  });
}

async function segmentFill(locator: Locator) {
  return locator.evaluate(async (element) => {
    // Segments cross-fade when the selection moves, so read them settled.
    await Promise.all(
      element.getAnimations().map((animation) => {
        return animation.finished;
      }),
    );
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
    };
  });
}

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
});

test("home content keeps its reserved offset while the growth entry loads", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const orgRequested = deferred();
  const releaseOrg = deferred();
  const slackStatusRequested = deferred();
  const releaseSlackStatus = deferred();
  await page.route(
    (url) => url.pathname === "/api/org",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      orgRequested.resolve();
      await releaseOrg.promise;
      await route.fulfill({
        json: { id: "org_admin", name: "Admin Org", role: "admin" },
      });
    },
  );
  await page.route("**/api/integrations/slack", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    slackStatusRequested.resolve();
    await releaseSlackStatus.promise;
    await route.fulfill({
      json: {
        connectUrl: null,
        environment: {
          missingSecrets: [],
          missingVars: [],
          requiredSecrets: [],
          requiredVars: [],
        },
        installUrl: null,
        isAdmin: true,
        isConnected: false,
        isInstalled: true,
        reinstallUrl: null,
        scopeMismatch: false,
        workspaceName: null,
      },
    });
  });

  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  await orgRequested.promise;

  const growthEntry = page.getByTestId("growth-entry");
  const main = page.locator("main");
  const tagline = page.getByTestId("chat-tagline");
  await expect(tagline).toBeVisible({ timeout: 20_000 });
  await expect(growthEntry).not.toBeAttached();
  const mainBefore = await main.boundingBox();
  const taglineBefore = await tagline.boundingBox();
  if (!mainBefore || !taglineBefore) {
    throw new Error("Home content has no measurable layout before entry load");
  }
  // Reserve the former 56px header slot before either async dependency resolves.
  expect(mainBefore.y).toBe(56);

  releaseOrg.resolve();
  await slackStatusRequested.promise;
  await expect(growthEntry).not.toBeAttached();
  const mainAfterRole = await main.boundingBox();
  const taglineAfterRole = await tagline.boundingBox();
  if (!mainAfterRole || !taglineAfterRole) {
    throw new Error("Home content has no measurable layout after role load");
  }
  expect(mainAfterRole.y).toBe(mainBefore.y);
  expect(mainAfterRole.height).toBe(mainBefore.height);
  expect(taglineAfterRole.y).toBe(taglineBefore.y);

  releaseSlackStatus.resolve();
  await expect(growthEntry).toBeVisible();
  await expect(growthEntry).toContainText("Invite humans 🤝");
  const mainAfter = await main.boundingBox();
  const taglineAfter = await tagline.boundingBox();
  if (!mainAfter || !taglineAfter) {
    throw new Error("Home content has no measurable layout after entry load");
  }

  expect(mainAfter.y).toBe(mainBefore.y);
  expect(mainAfter.height).toBe(mainBefore.height);
  expect(taglineAfter.y).toBe(taglineBefore.y);
});

test("non-admin home content keeps the reserved desktop offset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(
    (url) => url.pathname === "/api/org",
    async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: { id: "org_member", name: "Member Org", role: "member" },
      });
    },
  );
  const memberOrgLoaded = page.waitForResponse((response) => {
    const request = response.request();
    return (
      response.ok() &&
      request.method() === "GET" &&
      new URL(response.url()).pathname === "/api/org"
    );
  });

  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  await memberOrgLoaded;
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
  // Let the member role commit before reading the stable layout.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });

  await expect(page.getByTestId("growth-entry")).not.toBeAttached();
  const mainBox = await page.locator("main").boundingBox();
  if (!mainBox) {
    throw new Error("Non-admin home content has no measurable layout");
  }
  expect(mainBox.y).toBe(56);
});

test("checkmark keeps its column across selection states and previews deactivation", async ({
  page,
}) => {
  await mockSelectedFastModel(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "GPT 5.6 Sol Fast", exact: true })
    .click();
  await expectModelRowColumns(page);
  const fastOption = page.getByRole("option", {
    name: "GPT 5.6 Sol Fast",
    exact: true,
  });
  const fastIcon = fastOption.locator("svg.lucide-zap");
  await expect(fastIcon).not.toHaveCSS("fill", "none");

  await fastOption.hover();
  await expect(fastIcon).toHaveCSS("fill", "none");

  await fastOption.click();
  await page
    .getByRole("combobox", { name: "GPT 5.6 Sol", exact: true })
    .click();
  await expectModelRowColumns(page);
});

test("model picker grows by a row rather than scrolling", async ({ page }) => {
  const boundary = await mockModelPickerBoundary(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const sevenModels = await openModelPickerAndReadGeometry(page);
  expect(sevenModels).toStrictEqual({
    clientHeight: 288,
    optionCount: 7,
    rowStep: 36,
    scrollHeight: 288,
  });

  boundary.showEightModels();
  await page.reload();

  // The popup is bounded by the space it has, not by a row count, so an eighth
  // model makes it one row taller instead of parking that row under a
  // scrollbar. A fixed cap used to stop it here, and the category-switch height
  // animation kept travelling to a height the popup could not reach.
  const eightModels = await openModelPickerAndReadGeometry(page);
  expect(eightModels).toStrictEqual({
    clientHeight: 324,
    optionCount: 8,
    rowStep: 36,
    scrollHeight: 324,
  });
  expect(eightModels.clientHeight - sevenModels.clientHeight).toBe(
    eightModels.rowStep,
  );
});

test("model picker stops at the space it has on a short viewport", async ({
  page,
}) => {
  const boundary = await mockModelPickerBoundary(page);
  boundary.showEightModels();
  // Removing the row-count cap leaves the available height as the popup's only
  // bound, so it needs a case where that bound bites. 320px is under the 324px
  // the eight-model list asks for, which makes this independent of where the
  // composer happens to sit: no popup can both stay on screen and show every
  // row here. An unbounded popup -- or one still capped at `SelectContent`'s
  // own 24rem default, which outlives this viewport -- would lay out its whole
  // list and run past the screen instead of scrolling.
  await page.setViewportSize({ width: 1280, height: 320 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "Claude Fable 5", exact: true })
    .click();
  const popup = page.locator('[data-slot="select-content"]');
  await expect(popup).toBeVisible();
  await expect(popup).toBeInViewport({ ratio: 1 });
  const bounded = await popup.evaluate((element) => {
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(bounded.scrollHeight).toBeGreaterThan(bounded.clientHeight);
});

test("model picker image category settles without a scrollbar", async ({
  page,
}) => {
  await mockModelPickerBoundary(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "Claude Fable 5", exact: true })
    .click();
  const popup = page.locator('[data-slot="select-content"]');
  await expect(popup).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Models" })
    .getByRole("radio", { name: "Image" })
    .click();

  // The image catalog is the longest of the three categories, so it is the one
  // that outgrew the old cap. The switch animates the popup's height and hides
  // the overflow while it runs, so wait for the rows to land and the animation
  // to finish -- that is the frame where a scrollbar used to appear.
  const imageRows = popup.locator('[data-slot="select-group"] > button');
  await expect(imageRows.last()).toBeVisible();
  const imageCategory = await popup.evaluate(async (element) => {
    // The resize observer starts the height animation from the frame the
    // swapped list lays out in, so let that frame pass before collecting it.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    await Promise.all(
      element.getAnimations().map((animation) => {
        return animation.finished;
      }),
    );
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
  expect(imageCategory.scrollHeight).toBe(imageCategory.clientHeight);
  expect(imageCategory.scrollTop).toBe(0);
  // Every row the category offers is on screen, so nothing is hidden below the
  // fold that the height assertion above would miss.
  await expect(imageRows.last()).toBeInViewport({ ratio: 1 });
});

test("model picker category switch marks its selection without a raised shadow", async ({
  page,
}) => {
  await mockModelPickerBoundary(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "Claude Fable 5", exact: true })
    .click();
  const categorySwitch = page.getByRole("radiogroup", { name: "Models" });
  const chatCategory = categorySwitch.getByRole("radio", { name: "Chat" });
  const imageCategory = categorySwitch.getByRole("radio", { name: "Image" });
  await imageCategory.click();
  await expect(imageCategory).toBeChecked();

  // The switch sits straight on the popover surface with no track to lift off,
  // so the selection is a flat state layer: readable against its neighbours,
  // and carrying none of the raised segment's shadow.
  const [selected, unselected] = await Promise.all([
    segmentFill(imageCategory),
    segmentFill(chatCategory),
  ]);
  expect(selected.boxShadow).toBe("none");
  expect(selected.backgroundColor).not.toBe(unselected.backgroundColor);
});

test("model picker category switch keeps its measurement row hidden", async ({
  page,
}) => {
  await mockModelPickerBoundary(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "Claude Fable 5", exact: true })
    .click();
  const imageCategory = page
    .getByRole("radiogroup", { name: "Models" })
    .getByRole("radio", { name: "Image" });
  await expect(imageCategory).toBeVisible();

  // A media category replaces the model rows, so the selected chat model stays
  // in the list as a 1px, transparent row the select can still measure. The
  // swap fades the rows it brings in, and a keyframe outranks the class that
  // hides that row: fading it printed the model name over the header for the
  // whole fade. The click and the read share one evaluate because a round trip
  // between them can outlast the fade and miss the row while it is lit.
  const swap = await imageCategory.evaluate(async (segment) => {
    if (!(segment instanceof HTMLElement)) {
      throw new Error("Model picker category segment is not an HTML element");
    }
    segment.click();
    // The fade starts once the swapped list has laid out, so let one frame
    // carry the resize and read on the next.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
    const list = document.querySelector('[data-slot="select-list"]');
    if (list === null) {
      throw new Error("Model picker has no list");
    }
    const measurementRow = list.querySelector(
      '[data-slot="select-item"][aria-hidden="true"]',
    );
    const modelRows = list.querySelector('[data-slot="select-group"]');
    if (measurementRow === null || modelRows === null) {
      throw new Error("Model picker list has no measurement row or model rows");
    }
    return {
      measurementRowOpacity: getComputedStyle(measurementRow).opacity,
      modelRowsOpacity: getComputedStyle(modelRows).opacity,
    };
  });
  expect(swap.measurementRowOpacity).toBe("0");
  // The rows the swap brings in are mid-fade at that same instant. Asserting
  // that keeps the swap covered from both sides: the fade the picker still
  // owes its rows, and proof that the sample landed inside the fade rather
  // than after it, where a hidden row reads as transparent either way.
  expect(Number(swap.modelRowsOpacity)).toBeLessThan(1);
});

test("chat composer keeps the model icon unclipped on narrow screens", async ({
  page,
}) => {
  await mockSelectedFastModel(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const modelPicker = page.getByRole("combobox", {
    name: "GPT 5.6 Sol Fast",
    exact: true,
  });
  const visibleIcons = modelPicker.locator("img:visible, svg:visible");
  await expect(visibleIcons).toHaveCount(1);
  await expect(visibleIcons.first()).toBeInViewport({ ratio: 1 });
});

test("send a message through the deployed runner", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".zero-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf ${marker}`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toBeVisible({ timeout: 90_000 });
});

test("chat composer keeps standard tool icons and Send inside on narrow screens", async ({
  page,
}) => {
  await mockComposerConnectorState(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".zero-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
  const attachButton = composer.getByRole("button", {
    name: "Attach",
    exact: true,
  });
  const templateButton = composer.getByRole("button", {
    name: "Template",
    exact: true,
  });
  const workflowButton = composer.getByRole("button", {
    name: "Create workflow",
  });
  const connectorsButton = composer.getByRole("button", {
    name: "Connectors",
    exact: true,
  });
  const microphoneButton = composer.getByRole("button", {
    name: "Voice input",
  });
  const sendButton = composer.getByRole("button", { name: "Send" });

  await expect(connectorsButton.locator("img")).toHaveCount(0);
  await connectorsButton.click();
  await expect(connectorsButton.locator("img")).toHaveCount(2);
  await expect(
    page.getByRole("switch", { name: "Disable Cloud browser" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await editor.fill("Keep the mobile Send button contained");
  await expect(microphoneButton).toBeVisible();
  await expect(sendButton).toBeEnabled();

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 780 });
    await expect(workflowButton).toBeVisible();
    await expect(connectorsButton.locator("img:visible")).toHaveCount(0);
    await expect(
      connectorsButton.locator("img:visible, svg:visible"),
    ).toHaveCount(1);
    await expectInside(sendButton, composer);
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(workflowButton).toBeVisible();
  await expect(connectorsButton.locator("img:visible")).toHaveCount(2);
  await expect(
    connectorsButton.locator("img:visible, svg:visible"),
  ).toHaveCount(3);
  for (const control of [
    attachButton,
    templateButton,
    workflowButton,
    microphoneButton,
  ]) {
    expect(await computedIconStyle(control)).toStrictEqual({
      height: "18px",
      opacity: "1",
      width: "18px",
    });
  }
  await expectInside(sendButton, composer);

  await waitForAgentDraftClear(page, async () => {
    await clearComposerEditor(editor);
  });
});

test("forward composer stays inside the modal on narrow screens", async ({
  page,
  sharedWorkerRoutes,
}) => {
  await enableChatForward(page);
  await page.setViewportSize({ width: 360, height: 780 });
  const agentId = waitForActiveAgentId(page);
  const mockRoutes = await mockForwardLayoutThread(
    page,
    sharedWorkerRoutes,
    agentId,
  );
  await page.goto(appUrl);
  await agentId;
  await sharedWorkerRoutes.waitForWorker();
  await navigateToMockChatThread(
    page,
    forwardLayoutThreadId,
    mockRoutes.events,
    mockRoutes.eventRows,
  );

  const assistantReply = page.getByText(
    "Keep the forward composer within the modal.",
    { exact: true },
  );
  await assistantReply.selectText();
  await page.getByRole("button", { name: /^Forward\b/ }).click();

  const dialog = page.getByRole("dialog", { name: "Forward to" });
  await dialog.getByRole("option", { name: forwardLayoutThreadTitle }).click();
  const composerDialog = page.getByRole("dialog", {
    name: forwardLayoutThreadTitle,
  });
  const title = composerDialog.getByRole("heading", {
    name: forwardLayoutThreadTitle,
  });
  const composerSurface = composerDialog.locator("[data-chat-composer]");
  const composer = composerDialog.locator(".zero-composer");

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 780 });
    await expectInside(title, composerDialog);
    await expectInside(composer, composerDialog);
    await expect
      .poll(async () => {
        return await composerSurface.evaluate((element) => {
          const style = getComputedStyle(element);
          return [
            style.paddingTop,
            style.paddingRight,
            style.paddingBottom,
            style.paddingLeft,
          ];
        });
      })
      .toEqual(["20px", "20px", "20px", "20px"]);
  }
});

test("model change labels follow the divider at the right edge", async ({
  page,
  sharedWorkerRoutes,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const agentId = waitForActiveAgentId(page);
  const mockRoutes = await mockModelChangeThread(
    page,
    sharedWorkerRoutes,
    agentId,
  );
  await page.goto(appUrl);
  await agentId;
  await sharedWorkerRoutes.waitForWorker();
  await navigateToMockChatThread(
    page,
    modelChangeThreadId,
    mockRoutes.events,
    mockRoutes.eventRows,
  );

  await expectRightAlignedDivider(
    page.getByText("Model changed to Claude Sonnet 4.6", { exact: true }),
  );
  await expectRightAlignedDivider(
    page.getByText("Next run will use Claude Opus 4.8", { exact: true }),
  );
});

test("consecutive body cards keep a block gap between them", async ({
  page,
  sharedWorkerRoutes,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const agentId = waitForActiveAgentId(page);
  const mockRoutes = await mockCardSpacingThread(
    page,
    sharedWorkerRoutes,
    agentId,
  );
  await page.goto(appUrl);
  await agentId;
  await sharedWorkerRoutes.waitForWorker();
  await navigateToMockChatThread(
    page,
    cardSpacingThreadId,
    mockRoutes.events,
    mockRoutes.eventRows,
  );

  const cards = page.getByTestId("computer-use-authorization-card");
  await expect(cards).toHaveCount(2);

  // A card slot enters the markdown tree as a paragraph and leaves it as the
  // card element, so without the block margin the two borders would touch.
  await expect
    .poll(async () => {
      const [first, second] = await Promise.all([
        cards.nth(0).boundingBox(),
        cards.nth(1).boundingBox(),
      ]);
      if (!first || !second) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(second.y - (first.y + first.height) - cardSlotGapPx);
    })
    .toBeLessThan(2);
});

test("image preview frames stay fixed while delayed images load", async ({
  page,
  sharedWorkerRoutes,
}) => {
  const routes = await setupDelayedImageRoutes(page);
  const agentId = waitForActiveAgentId(page);
  const mockRoutes = await mockDelayedImageLayoutThread(
    page,
    sharedWorkerRoutes,
    agentId,
    routes,
  );
  await page.goto(appUrl);
  await agentId;
  await sharedWorkerRoutes.waitForWorker();
  await mockRoutes.events.handled;

  await page.goto(new URL(`/chats/${imageLayoutThreadId}`, appUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await mockRoutes.eventRows.handled;

  const user = delayedImagePreview(
    page,
    "user",
    "delayed-user-image.svg",
    "User image follower",
  );
  const assistant = delayedImagePreview(
    page,
    "assistant",
    "delayed-assistant-image.svg",
    "Assistant image follower",
  );

  await expect(user.preview).toBeVisible();
  await expect(assistant.preview).toBeVisible();
  await expect(user.follower).toBeVisible();
  await expect(assistant.follower).toBeVisible();
  await Promise.all([
    routes.userImageRequested,
    routes.assistantImageRequested,
  ]);
  const userBefore = await imagePreviewGeometry(user);
  const assistantBefore = await imagePreviewGeometry(assistant);

  routes.releaseImages();
  await expect
    .poll(async () => {
      return Promise.all([
        user.image.evaluate((element) => {
          return element instanceof HTMLImageElement && element.naturalWidth;
        }),
        assistant.image.evaluate((element) => {
          return element instanceof HTMLImageElement && element.naturalWidth;
        }),
      ]);
    })
    .toEqual([1200, 1200]);

  const userAfter = await imagePreviewGeometry(user);
  const assistantAfter = await imagePreviewGeometry(assistant);
  expectStableImagePreviewGeometry(userBefore, userAfter);
  expectStableImagePreviewGeometry(assistantBefore, assistantAfter);
  expectImageInsidePreviewBorder(userAfter);
  expectImageInsidePreviewBorder(assistantAfter);
  await expectPreviewFocusVisible(user.preview);
  await expectPreviewFocusVisible(assistant.preview);
});

// The card rail only renders on coarse-pointer text-entry devices, so this
// group emulates touch instead of relying on the viewport width alone.
test.describe("mobile follow-up card rail", () => {
  test.use({ hasTouch: true });

  test("responsive follow-up rail aligns its edges and equalizes card heights", async ({
    page,
    sharedWorkerRoutes,
  }) => {
    await enableResponsiveFollowupCards(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const agentId = waitForActiveAgentId(page);
    const mockRoutes = await mockResponsiveFollowupThread(
      page,
      sharedWorkerRoutes,
      agentId,
    );
    await page.goto(appUrl);
    await agentId;
    await sharedWorkerRoutes.waitForWorker();
    await navigateToMockChatThread(
      page,
      responsiveFollowupThreadId,
      mockRoutes.events,
      mockRoutes.eventRows,
    );

    const rail = page.getByRole("group", { name: "Keep going" });
    const cards = responsiveFollowupPrompts.map((prompt) => {
      return page.getByRole("button", { name: prompt, exact: true });
    });
    await expect(rail).toBeVisible();
    for (const card of cards) {
      await expect(card).toBeVisible();
    }

    await expect
      .poll(async () => {
        const railBox = await rail.boundingBox();
        const firstBox = await cards[0].boundingBox();
        if (!railBox || !firstBox) {
          return Number.POSITIVE_INFINITY;
        }
        return Math.abs(firstBox.x - railBox.x);
      })
      .toBeLessThan(1);
    await expect
      .poll(async () => {
        const boxes = await Promise.all(
          cards.map((card) => card.boundingBox()),
        );
        if (boxes.some((box) => box === null)) {
          return Number.POSITIVE_INFINITY;
        }
        const heights = boxes.map((box) => box!.height);
        return Math.max(...heights) - Math.min(...heights);
      })
      .toBeLessThan(1);

    await cards[1].evaluate((element) => {
      element.scrollIntoView({ block: "nearest", inline: "center" });
    });
    await expect
      .poll(async () => {
        const railBox = await rail.boundingBox();
        const middleBox = await cards[1].boundingBox();
        if (!railBox || !middleBox) {
          return Number.POSITIVE_INFINITY;
        }
        const railCenter = railBox.x + railBox.width / 2;
        const cardCenter = middleBox.x + middleBox.width / 2;
        return Math.abs(cardCenter - railCenter);
      })
      .toBeLessThan(2);

    await rail.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect
      .poll(async () => {
        const railBox = await rail.boundingBox();
        const lastBox = await cards[2].boundingBox();
        if (!railBox || !lastBox) {
          return Number.POSITIVE_INFINITY;
        }
        return Math.abs(
          lastBox.x + lastBox.width - (railBox.x + railBox.width),
        );
      })
      .toBeLessThan(1);

    // The rail is a device decision, so a wide viewport on the same touch
    // device keeps the cards instead of collapsing them into full-width rows.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(async () => {
        const railBox = await rail.boundingBox();
        const firstBox = await cards[0].boundingBox();
        if (!railBox || !firstBox) {
          return 0;
        }
        return railBox.width - firstBox.width;
      })
      .toBeGreaterThan(100);

    await page.keyboard.press("Tab");
    await cards[0].focus();
    await expect
      .poll(async () => {
        return cards[0].evaluate((element) => {
          return (
            element.matches(":focus-visible") &&
            getComputedStyle(element).boxShadow !== "none"
          );
        });
      })
      .toBe(true);
  });
});

test("keeps the flat follow-up list in a narrow desktop window", async ({
  page,
  sharedWorkerRoutes,
}) => {
  await enableResponsiveFollowupCards(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const agentId = waitForActiveAgentId(page);
  const mockRoutes = await mockResponsiveFollowupThread(
    page,
    sharedWorkerRoutes,
    agentId,
  );
  await page.goto(appUrl);
  await agentId;
  await sharedWorkerRoutes.waitForWorker();
  await navigateToMockChatThread(
    page,
    responsiveFollowupThreadId,
    mockRoutes.events,
    mockRoutes.eventRows,
  );

  const list = page.getByRole("group", { name: "Keep going" });
  const rows = responsiveFollowupPrompts.map((prompt) => {
    return page.getByRole("button", { name: prompt, exact: true });
  });
  await expect(list).toBeVisible();
  for (const row of rows) {
    await expect(row).toBeVisible();
  }

  // A fine-pointer window dragged this narrow keeps the flat vertical list:
  // every follow-up spans the full width instead of becoming a card.
  await expect
    .poll(async () => {
      const listBox = await list.boundingBox();
      const boxes = await Promise.all(rows.map((row) => row.boundingBox()));
      if (!listBox || boxes.some((box) => box === null)) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.max(
        ...boxes.map((box) => Math.abs(box!.width - listBox.width)),
      );
    })
    .toBeLessThan(2);
  await expect
    .poll(async () => {
      const boxes = await Promise.all(rows.map((row) => row.boundingBox()));
      if (boxes.some((box) => box === null)) {
        return 0;
      }
      const tops = boxes.map((box) => box!.y);
      return Math.max(...tops) - Math.min(...tops);
    })
    .toBeGreaterThan(0);
});

test("image lightbox centers and pans across the full viewer", async ({
  page,
}) => {
  await enableFeatureSwitch(page, "composerImageAnnotation");
  const imageMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
      <rect width="1200" height="900" fill="#2563eb" />
    </svg>
  `;
  const imageUrl = new URL("/playwright/lightbox-geometry.svg", appUrl).href;
  const uploadUrl = new URL("/playwright/lightbox-upload", appUrl).href;

  await page.route("**/api/uploads/prepare", async (route) => {
    await route.fulfill({
      json: {
        id: "playwright-lightbox-geometry",
        filename: "lightbox.svg",
        contentType: "image/svg+xml",
        size: Buffer.byteLength(imageMarkup),
        url: imageUrl,
        uploadUrl,
      },
    });
  });
  await page.route(uploadUrl, async (route) => {
    await route.fulfill({ status: 200 });
  });
  await page.route(imageUrl, async (route) => {
    await route.fulfill({
      body: imageMarkup,
      contentType: "image/svg+xml",
    });
  });

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await page
    .getByRole("main")
    .locator('input[type="file"]')
    .setInputFiles({
      buffer: Buffer.from(imageMarkup),
      mimeType: "image/svg+xml",
      name: "lightbox.svg",
    });

  await page
    .getByRole("button", { name: "Open image preview for lightbox.svg" })
    .click();

  const lightbox = page.getByTestId("attachment-lightbox");
  const lightboxPanel = lightbox.getByTestId("attachment-lightbox-panel");
  const stage = lightbox.getByTestId("artifact-dialog-image-stage");
  const image = lightbox.getByTestId("attachment-lightbox-image");
  await expect(lightbox).toBeVisible();
  await expect(lightboxPanel).toBeVisible();
  await expect(image).toBeVisible();
  expect(
    await lightboxPanel.evaluate((element) => {
      return getComputedStyle(element).borderRadius;
    }),
  ).toBe("14px");
  await expect
    .poll(async () => {
      return image.evaluate((element) => {
        return element instanceof HTMLImageElement ? element.naturalWidth : 0;
      });
    })
    .toBeGreaterThan(0);

  await expect
    .poll(async () => {
      const stageBox = await stage.boundingBox();
      const imageBox = await image.boundingBox();
      if (!stageBox || !imageBox) {
        return Number.POSITIVE_INFINITY;
      }
      const horizontalDelta = Math.abs(
        imageBox.x + imageBox.width / 2 - (stageBox.x + stageBox.width / 2),
      );
      const verticalDelta = Math.abs(
        imageBox.y + imageBox.height / 2 - (stageBox.y + stageBox.height / 2),
      );
      return Math.max(horizontalDelta, verticalDelta);
    })
    .toBeLessThan(2);

  const zoomIn = lightbox.getByRole("button", { name: "Zoom in" });
  for (let step = 0; step < 4; step += 1) {
    await zoomIn.click();
  }
  await expect(lightbox.getByText("160%", { exact: true })).toBeVisible();

  const imageBeforePan = await image.boundingBox();
  const stageBox = await stage.boundingBox();
  if (!imageBeforePan || !stageBox) {
    throw new Error("Image lightbox geometry unavailable");
  }

  const dragStart = {
    x: stageBox.x + stageBox.width / 2,
    y: stageBox.y + stageBox.height / 2,
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 210, dragStart.y + 120, { steps: 10 });
  await page.mouse.up();

  await expect
    .poll(async () => {
      const imageAfterPan = await image.boundingBox();
      return imageAfterPan ? imageAfterPan.x - imageBeforePan.x : 0;
    })
    .toBeGreaterThan(180);
  await expect
    .poll(async () => {
      const imageAfterPan = await image.boundingBox();
      return imageAfterPan ? imageAfterPan.y - imageBeforePan.y : 0;
    })
    .toBeGreaterThan(90);

  await lightbox.getByRole("button", { name: "Close" }).click();
  await expect(lightbox).toBeHidden();

  await page
    .getByRole("button", { name: "Open image preview for lightbox.svg" })
    .click();
  await page.getByTestId("artifact-dialog-annotate").click();

  const annotationEditor = page.getByTestId("image-annotation-editor");
  const annotationPanel = page.getByTestId("image-annotation-panel");
  await expect(annotationEditor).toBeVisible();
  await expect(annotationPanel).toBeVisible();
  expect(
    await annotationPanel.evaluate((element) => {
      return getComputedStyle(element).borderRadius;
    }),
  ).toBe("14px");

  await annotationEditor.getByRole("button", { name: "Close" }).click();
  await expect(annotationEditor).toBeHidden();
  await waitForAgentDraftClear(page, async () => {
    await page.getByRole("button", { name: "Remove lightbox.svg" }).click();
  });
});

test("avatar catalog surfaces stay stable while scrolling and selecting", async ({
  page,
}) => {
  await page.route("**/api/avatar-video/avatars**", async (route) => {
    await route.fulfill({
      json: {
        avatars: [
          { id: 81, name: "Ada", aspectRatio: 0 },
          { id: 82, name: "Alex", aspectRatio: 0 },
          ...Array.from({ length: 16 }, (_, index) => {
            return {
              id: index + 83,
              name: `Avatar ${String(index + 3)}`,
              aspectRatio: 0,
            };
          }),
        ],
      },
    });
  });
  await page.route("**/api/avatar-video/voices**", async (route) => {
    await route.fulfill({
      json: {
        voices: [
          {
            id: "en-US-ChristopherNeural",
            name: "Christopher",
            language: "English",
            gender: "male",
          },
          {
            id: "en-US-AvaNeural",
            name: "Ava",
            language: "English",
            gender: "female",
          },
        ],
        hasMore: false,
        filterOptions: { languages: ["english"], useCases: [] },
      },
    });
  });

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  // Exact: the start cards under the composer also carry "Templates" actions.
  await page.getByRole("button", { name: "Template", exact: true }).click();
  await page.getByRole("tab", { name: "Avatar" }).click();
  const dialog = page.getByRole("dialog");
  const avatarScroll = dialog.locator("[data-avatar-template-grid-scroll]");
  const avatarToolbar = dialog.locator("[data-avatar-catalog-toolbar]");
  await expect(avatarToolbar).toBeVisible();
  // The toolbar shares the dialog header row with the close button, so catalog
  // cards can never scroll underneath it.
  await expect(
    avatarScroll.locator("[data-avatar-catalog-toolbar]"),
  ).toHaveCount(0);
  await avatarScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => {
      return avatarScroll.evaluate((element) => {
        return element.scrollTop;
      });
    })
    .toBeGreaterThan(0);
  await expect(avatarToolbar).toBeInViewport();

  await page.getByRole("button", { name: "Select template Ada" }).click();
  const voiceScroll = dialog.locator("[data-avatar-voice-list-scroll]");
  const voiceToolbar = dialog.locator("[data-avatar-voice-toolbar]");
  await expect(voiceToolbar).toBeVisible();
  await expect(voiceScroll.locator("[data-avatar-voice-toolbar]")).toHaveCount(
    0,
  );
  await expect(voiceToolbar).toBeInViewport();
  await page.getByRole("button", { name: "Select voice Christopher" }).click();

  await page.getByRole("button", { name: "Preview template Ada" }).click();
  await page.mouse.move(0, 0);
  const selectedAvatar = page.getByRole("button", {
    name: "Select template Ada",
  });
  const unselectedAvatar = page.getByRole("button", {
    name: "Select template Alex",
  });
  await expect(selectedAvatar).toHaveAttribute("aria-pressed", "true");
  await expect(unselectedAvatar).toHaveAttribute("aria-pressed", "false");
  const selectedAvatarEdge = await cardEdgeAppearance(selectedAvatar);
  const unselectedAvatarEdge = await cardEdgeAppearance(unselectedAvatar);
  expect(selectedAvatarEdge.borderWidths).toEqual(["1px", "1px", "1px", "1px"]);
  expect(selectedAvatarEdge).toEqual(unselectedAvatarEdge);

  await selectedAvatar.click();
  await page.mouse.move(0, 0);
  const selectedVoice = page.getByRole("button", {
    name: "Select voice Christopher",
  });
  const unselectedVoice = page.getByRole("button", {
    name: "Select voice Ava",
  });
  await expect(selectedVoice).toHaveAttribute("aria-pressed", "true");
  await expect(unselectedVoice).toHaveAttribute("aria-pressed", "false");
  const selectedVoiceEdge = await cardEdgeAppearance(selectedVoice);
  const unselectedVoiceEdge = await cardEdgeAppearance(unselectedVoice);
  expect(selectedVoiceEdge.borderWidths).toEqual(["1px", "1px", "1px", "1px"]);
  expect(selectedVoiceEdge).toEqual(unselectedVoiceEdge);

  await dialog.getByRole("button", { name: "Close" }).click();
  await waitForAgentDraftClear(page, async () => {
    await clearComposerEditor(page.getByRole("textbox", { name: "Message" }));
  });
});
