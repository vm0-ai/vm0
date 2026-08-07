import type { Locator, Page, Response } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);
const composerConnectorSlugs = ["github", "slack", "asana"] as const;

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
  return locator.evaluate((element) => {
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

async function toolbarSurfaceAppearance(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context unavailable");
    }
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return {
      backgroundAlpha: context.getImageData(0, 0, 1, 1).data[3],
      borderBottomWidth: style.borderBottomWidth,
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
        supportsCustomConnectorOAuth2: true,
        supportsImageRecognition: true,
        supportsAvatarTemplates: true,
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
  const avatarToolbar = avatarScroll.locator("[data-avatar-catalog-toolbar]");
  await expect(avatarToolbar).toBeVisible();
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
  await expect
    .poll(async () => {
      return toolbarSurfaceAppearance(avatarToolbar);
    })
    .toEqual({ backgroundAlpha: 255, borderBottomWidth: "0px" });

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
