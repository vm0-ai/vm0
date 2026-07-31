import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

test("send a chat message and start an assistant response", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 20_000 });

  const modelPicker = page.locator(".zero-composer").getByRole("combobox");
  await modelPicker.click();
  await page.getByRole("option", { name: /^GPT 5\.6 Terra\b/ }).click();
  await expect(
    page
      .locator(".zero-composer")
      .getByRole("combobox", { name: "GPT 5.6 Terra", exact: true }),
  ).toBeVisible();

  const prompt = "Hello from Zero.";
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const userMessage = page.locator('[data-role="user"]').last();
  await expect(userMessage.getByText(prompt, { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible({
    timeout: 120_000,
  });
});
