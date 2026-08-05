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
