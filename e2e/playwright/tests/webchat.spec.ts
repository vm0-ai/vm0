import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

test("send a chat message and receive an assistant response", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 20_000 });

  const modelPicker = page.locator(".zero-composer").getByRole("combobox");
  await modelPicker.click();
  await page.getByRole("option", { name: /^GPT 5\.6 Luna\b/ }).click();
  await expect(
    page
      .locator(".zero-composer")
      .getByRole("combobox", { name: "GPT 5.6 Luna", exact: true }),
  ).toBeVisible();

  const prompt = `e2e-${Date.now()}`;
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  const userMessage = page.locator('[data-role="user"]').last();
  await expect(userMessage.getByText(prompt, { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  const assistantMessage = page.locator('[data-role="assistant"]').last();
  await expect(assistantMessage.getByText(prompt, { exact: true })).toBeVisible(
    {
      timeout: 120_000,
    },
  );
});
