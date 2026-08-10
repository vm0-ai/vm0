import type { Locator, Page, Response } from "@playwright/test";
import { expect, fetchApiPreviewRouteJson, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);
const composerConnectorSlugs = ["github", "slack", "asana"] as const;
const responsiveFollowupThreadId = "b0000000-0000-4000-a000-000000000734";
const modelChangeThreadId = "b0000000-0000-4000-a000-000000000735";
const imageLayoutThreadId = "b0000000-0000-4000-a000-000000000736";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
    !/^\/api\/okou\/agents\/[^/]+\/draft$/.test(
      new URL(response.url()).pathname,
    )
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

function isInitialChatThreadEventsResponse(
  response: Response,
  threadId: string,
): boolean {
  const request = response.request();
  const url = new URL(response.url());
  return (
    response.ok() &&
    request.method() === "GET" &&
    url.pathname === `/api/okou/chat-threads/${threadId}/events` &&
    !url.searchParams.has("sinceSeqId") &&
    !url.searchParams.has("beforeSeqId")
  );
}

async function navigateToMockChatThread(
  page: Page,
  threadId: string,
): Promise<void> {
  const initialEventsLoaded = page.waitForResponse((response) => {
    return isInitialChatThreadEventsResponse(response, threadId);
  });
  await page.goto(new URL(`/chats/${threadId}`, appUrl).href);
  await initialEventsLoaded;
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
  await page.route("**/api/okou/connector-catalog/status", async (route) => {
    const body = await fetchApiPreviewRouteJson(route);
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
  await page.route("**/api/okou/agents/*/user-connectors", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: { enabledConnectorSlugs: composerConnectorSlugs },
    });
  });
}

async function enableResponsiveFollowupCards(page: Page): Promise<void> {
  await page.route("**/api/okou/feature-switches", async (route) => {
    const body = await fetchApiPreviewRouteJson(route);
    if (!isRecord(body) || !isRecord(body.effectiveSwitches)) {
      throw new Error("Feature switches returned an unexpected response");
    }
    await route.fulfill({
      json: {
        ...body,
        effectiveSwitches: {
          ...body.effectiveSwitches,
          responsiveFollowupCards: true,
        },
      },
    });
  });
}

async function mockSelectedFastModel(page: Page): Promise<void> {
  const policyId = "00000000-0000-4000-a000-000000000736";
  await page.route("**/api/okou/feature-switches", async (route) => {
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
  await page.route("**/api/okou/billing/status", async (route) => {
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
  await page.route("**/api/okou/model-policies", async (route) => {
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
  await page.route("**/api/okou/user-model-preference", async (route) => {
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

interface MockChatThreadOptions {
  readonly agentId: string;
  readonly createdAt: string;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly selectedModel: string | null;
  readonly threadId: string;
  readonly title: string;
}

async function mockChatThread(
  page: Page,
  options: MockChatThreadOptions,
): Promise<void> {
  const createdEventId = `d${options.threadId.slice(1)}`;
  let createdEventSeqId: number | null = null;

  await page.route("**/api/okou/chat-threads/snapshot", async (route) => {
    await route.fulfill({
      json: {
        chatThreads: [],
        latestEventId: null,
        latestSeqId: null,
      },
    });
  });
  await page.route(
    (url) => url.pathname === "/api/okou/chat-threads/events",
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const rawSinceSeqId = requestUrl.searchParams.get("sinceSeqId");
      const sinceSeqId = rawSinceSeqId === null ? 0 : Number(rawSinceSeqId);
      if (!Number.isSafeInteger(sinceSeqId) || sinceSeqId < 0) {
        throw new Error("Thread event cursor is invalid");
      }

      // The initial real page can persist a thread-list cursor before these
      // routes are installed. Deliver the synthetic thread through the
      // incremental event stream so both cold and already-cached starts own a
      // deterministic path to the same thread metadata.
      createdEventSeqId ??= sinceSeqId + 1;
      const events =
        sinceSeqId < createdEventSeqId
          ? [
              {
                id: createdEventId,
                seqId: createdEventSeqId,
                kind: "created",
                chatThreadId: options.threadId,
                agentId: options.agentId,
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
  await page.route(
    (url) =>
      url.pathname === `/api/okou/chat-threads/${options.threadId}/events`,
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const isIncremental =
        requestUrl.searchParams.has("sinceSeqId") ||
        requestUrl.searchParams.has("beforeSeqId");
      await route.fulfill({
        json: { events: isIncremental ? [] : options.events },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/api/okou/chat-threads/${options.threadId}/draft`,
    async (route) => {
      await route.fulfill({
        json: { draftUserMessage: null, draftAttachments: null },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname === `/api/okou/chat-threads/${options.threadId}/mark-read`,
    async (route) => {
      await route.fulfill({
        json: { lastReadAt: options.createdAt, unreads: [] },
      });
    },
  );
  await page.route(
    (url) =>
      url.pathname ===
      `/api/okou/chat-threads/${options.threadId}/event-snapshot`,
    async (route) => {
      await route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Not found" } },
      });
    },
  );
  await page.route(
    (url) => url.pathname === `/api/okou/chat-threads/${options.threadId}`,
    async (route) => {
      await route.fulfill({
        json: {
          lastReadAt: options.createdAt,
          cancellationRecoveryPending: false,
        },
      });
    },
  );
}

async function mockResponsiveFollowupThread(
  page: Page,
  agentId: string,
): Promise<void> {
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

  await mockChatThread(page, {
    agentId,
    createdAt,
    events,
    selectedModel: null,
    threadId: responsiveFollowupThreadId,
    title: "Responsive follow-ups",
  });
}

async function mockModelChangeThread(
  page: Page,
  agentId: string,
): Promise<void> {
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
  await mockChatThread(page, {
    agentId,
    createdAt,
    events,
    selectedModel: "claude-opus-4-8",
    threadId: modelChangeThreadId,
    title: "Model change layout",
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
  await page.route("**/api/okou/web/file-url?*", async (route) => {
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
  agentId: string,
  routes: DelayedImageRoutes,
): Promise<void> {
  await page.route(
    (url) =>
      url.pathname ===
      `/api/okou/chat-threads/${imageLayoutThreadId}/artifacts`,
    async (route) => {
      await route.fulfill({ json: { runs: [] } });
    },
  );
  const runId = "run-delayed-image-layout";
  await mockChatThread(page, {
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

async function expectFastActionRightmost(page: Page): Promise<void> {
  const standardOption = page.getByRole("option", {
    name: "GPT 5.6 Sol",
    exact: true,
  });
  const fastOption = page.getByRole("option", {
    name: "GPT 5.6 Sol Fast",
    exact: true,
  });
  const selectedCheck = standardOption.locator("svg.lucide-check");
  const row = standardOption.locator("..");
  await expect(standardOption).toBeVisible();
  await expect(fastOption).toBeVisible();
  await expect(selectedCheck).toBeVisible();
  const [standardBox, fastBox, checkBox, rowBox] = await Promise.all([
    standardOption.boundingBox(),
    fastOption.boundingBox(),
    selectedCheck.boundingBox(),
    row.boundingBox(),
  ]);
  if (!standardBox || !fastBox || !checkBox || !rowBox) {
    throw new Error("Model picker option geometry unavailable");
  }
  const tolerance = 1;
  expect(standardBox.x + standardBox.width).toBeLessThanOrEqual(
    fastBox.x + tolerance,
  );
  expect(checkBox.x + checkBox.width).toBeLessThanOrEqual(
    fastBox.x + tolerance,
  );
  expect(
    Math.abs(fastBox.x + fastBox.width - (rowBox.x + rowBox.width)),
  ).toBeLessThan(tolerance);
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

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
});

test("Fast action stays rightmost across selection states and previews deactivation", async ({
  page,
}) => {
  await mockSelectedFastModel(page);
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page
    .getByRole("combobox", { name: "GPT 5.6 Sol Fast", exact: true })
    .click();
  await expectFastActionRightmost(page);
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
  await expectFastActionRightmost(page);
});

test("send a message through the deployed runner", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".zero-composer");
  const modelPicker = composer.getByRole("combobox");
  await modelPicker.click();
  await page.getByRole("option", { name: /Claude Sonnet 4\.6/ }).click();
  await expect(
    composer.getByRole("combobox", { name: "Claude Sonnet 4.6" }),
  ).toBeVisible();

  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf ${marker}`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toBeVisible({ timeout: 90_000 });
});

test("chat composer keeps the Send button inside on narrow screens", async ({
  page,
}) => {
  await mockComposerConnectorState(page);
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".zero-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
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

  await expect(connectorsButton.locator("img")).toHaveCount(3, {
    timeout: 30_000,
  });
  await connectorsButton.click();
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
  await expect(connectorsButton.locator("img:visible")).toHaveCount(3);
  await expect(
    connectorsButton.locator("img:visible, svg:visible"),
  ).toHaveCount(4);
  await expectInside(sendButton, composer);

  await waitForAgentDraftClear(page, async () => {
    await clearComposerEditor(editor);
  });
});

test("model change labels follow the divider at the right edge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  const agentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!agentId) {
    throw new Error("Could not resolve the active agent from the chat URL");
  }
  await mockModelChangeThread(page, agentId);
  await navigateToMockChatThread(page, modelChangeThreadId);

  await expectRightAlignedDivider(
    page.getByText("Model changed to Claude Sonnet 4.6", { exact: true }),
  );
  await expectRightAlignedDivider(
    page.getByText("Next run will use Claude Opus 4.8", { exact: true }),
  );
});

test("image preview frames stay fixed while delayed images load", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  const agentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!agentId) {
    throw new Error("Could not resolve the active agent from the chat URL");
  }
  const routes = await setupDelayedImageRoutes(page);
  await mockDelayedImageLayoutThread(page, agentId, routes);

  const initialEventsLoaded = page.waitForResponse((response) => {
    return isInitialChatThreadEventsResponse(response, imageLayoutThreadId);
  });
  await page.goto(new URL(`/chats/${imageLayoutThreadId}`, appUrl).href, {
    waitUntil: "domcontentloaded",
  });
  await initialEventsLoaded;

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
  }) => {
    await enableResponsiveFollowupCards(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(appUrl);
    await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

    const agentId = new URL(page.url()).pathname.match(
      /^\/agents\/([^/]+)\/chat\/?$/,
    )?.[1];
    if (!agentId) {
      throw new Error("Could not resolve the active agent from the chat URL");
    }
    await mockResponsiveFollowupThread(page, agentId);
    await navigateToMockChatThread(page, responsiveFollowupThreadId);

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
}) => {
  await enableResponsiveFollowupCards(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const agentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!agentId) {
    throw new Error("Could not resolve the active agent from the chat URL");
  }
  await mockResponsiveFollowupThread(page, agentId);
  await navigateToMockChatThread(page, responsiveFollowupThreadId);

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
  const imageMarkup = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
      <rect width="1200" height="900" fill="#2563eb" />
    </svg>
  `;
  const imageUrl = new URL("/playwright/lightbox-geometry.svg", appUrl).href;
  const uploadUrl = new URL("/playwright/lightbox-upload", appUrl).href;

  await page.route("**/api/okou/uploads/prepare", async (route) => {
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
  const stage = lightbox.getByTestId("artifact-dialog-image-stage");
  const image = lightbox.getByTestId("attachment-lightbox-image");
  await expect(lightbox).toBeVisible();
  await expect(image).toBeVisible();
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
  await waitForAgentDraftClear(page, async () => {
    await page.getByRole("button", { name: "Remove lightbox.svg" }).click();
  });
});

test("avatar catalog surfaces stay stable while scrolling and selecting", async ({
  page,
}) => {
  await page.route("**/api/okou/feature-switches", async (route) => {
    await route.fulfill({
      json: {
        switches: {},
        effectiveSwitches: { joggAiBuiltIn: true },
      },
    });
  });
  await page.route("**/api/okou/avatar-video/avatars**", async (route) => {
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
  await page.route("**/api/okou/avatar-video/voices**", async (route) => {
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
  await page.getByRole("button", { name: "Template" }).click();
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
