import type { Locator } from "@playwright/test";
import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

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

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
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
  await page.locator('input[type="file"]').setInputFiles({
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
  await page.getByRole("button", { name: "Remove lightbox.svg" }).click();
});

test("selected avatar and voice cards keep a single border", async ({
  page,
}) => {
  await page.route("**/api/zero/feature-switches", async (route) => {
    await route.fulfill({
      json: {
        switches: {},
        effectiveSwitches: { joggAiBuiltIn: true },
        supportsStructuredInlineTemplates: true,
        supportsCustomConnectorOAuth2: true,
        supportsCustomModelGateways: true,
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
});
