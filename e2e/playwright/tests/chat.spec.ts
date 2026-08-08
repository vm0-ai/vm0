import type { Locator, Page, Response } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);
const composerConnectorSlugs = ["github", "slack", "asana"] as const;
const responsiveFollowupThreadId = "b0000000-0000-4000-a000-000000000734";
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

function isSuccessfulAgentDraftClear(response: Response): boolean {
  const request = response.request();
  if (
    !response.ok() ||
    request.method() !== "PATCH" ||
    !/^\/api\/zero\/agents\/[^/]+\/draft$/.test(
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
  await page.route("**/api/zero/connector-catalog/status", async (route) => {
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
  await page.route("**/api/zero/agents/*/user-connectors", async (route) => {
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
  await page.route("**/api/zero/feature-switches", async (route) => {
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
          chatEventSnapshotRead: false,
          responsiveFollowupCards: true,
        },
      },
    });
  });
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

  await page.route("**/api/zero/chat-threads/snapshot", async (route) => {
    await route.fulfill({
      json: {
        chatThreads: [
          {
            id: responsiveFollowupThreadId,
            agentId,
            title: "Responsive follow-ups",
            sortAt: createdAt,
            createdAt,
            updatedAt: createdAt,
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
            cloudBrowserEnabled: false,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      },
    });
  });
  await page.route(
    new RegExp(
      `/api/zero/chat-threads/${responsiveFollowupThreadId}/events(?:\\?.*)?$`,
    ),
    async (route) => {
      const requestUrl = new URL(route.request().url());
      const isIncremental =
        requestUrl.searchParams.has("sinceSeqId") ||
        requestUrl.searchParams.has("beforeSeqId");
      await route.fulfill({ json: { events: isIncremental ? [] : events } });
    },
  );
  await page.route(
    new RegExp(
      `/api/zero/chat-threads/${responsiveFollowupThreadId}/draft(?:\\?.*)?$`,
    ),
    async (route) => {
      await route.fulfill({
        json: { draftUserMessage: null, draftAttachments: null },
      });
    },
  );
  await page.route(
    new RegExp(
      `/api/zero/chat-threads/${responsiveFollowupThreadId}/mark-read(?:\\?.*)?$`,
    ),
    async (route) => {
      await route.fulfill({ json: { lastReadAt: createdAt, unreads: [] } });
    },
  );
  await page.route(
    new RegExp(
      `/api/zero/chat-threads/${responsiveFollowupThreadId}/event-snapshot(?:\\?.*)?$`,
    ),
    async (route) => {
      await route.fulfill({
        status: 404,
        json: { error: { code: "NOT_FOUND", message: "Not found" } },
      });
    },
  );
  await page.route(
    new RegExp(
      `/api/zero/chat-threads/${responsiveFollowupThreadId}(?:\\?.*)?$`,
    ),
    async (route) => {
      await route.fulfill({
        json: { lastReadAt: createdAt, cancellationRecoveryPending: false },
      });
    },
  );
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

  await expect(connectorsButton.locator("img")).toHaveCount(3);
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
    await page.goto(
      new URL(`/chats/${responsiveFollowupThreadId}`, appUrl).href,
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
  await page.goto(new URL(`/chats/${responsiveFollowupThreadId}`, appUrl).href);

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

  await page.route("**/api/zero/uploads/prepare", async (route) => {
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
  await page.route("**/api/zero/feature-switches", async (route) => {
    await route.fulfill({
      json: {
        switches: {},
        effectiveSwitches: { joggAiBuiltIn: true },
      },
    });
  });
  await page.route("**/api/zero/avatar-video/avatars**", async (route) => {
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
  await page.route("**/api/zero/avatar-video/voices**", async (route) => {
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
