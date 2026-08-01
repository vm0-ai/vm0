import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const apiUrl = process.env.VM0_API_BACKEND_URL!;
const appUrl = deriveAppUrl(apiUrl);
const attachmentImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("upload an attachment and receive a mock Claude response", async ({
  page,
}) => {
  const attachmentName = `playwright-mock-upload-${Date.now()}.png`;
  await page.route(`**/*${attachmentName}*`, async (route) => {
    const method = route.request().method();
    if (method === "OPTIONS") {
      const requestedHeaders = route.request().headers()[
        "access-control-request-headers"
      ];
      await route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-headers": requestedHeaders ?? "content-type",
          "access-control-allow-methods": "PUT, OPTIONS",
          "access-control-allow-origin": appUrl,
        },
      });
      return;
    }
    if (method === "PUT") {
      // Proxy the signed request outside browser CORS while preserving the
      // object-storage write exercised by the runner.
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "access-control-allow-origin": appUrl,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await page.waitForFunction(() => {
    const cached = localStorage.getItem("vm0:feature-switch-cache:v3");
    if (cached === null) {
      return false;
    }
    const parsed: unknown = JSON.parse(cached);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "realAgentInPreview" in parsed &&
      parsed.realAgentInPreview === false
    );
  });

  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 20_000 });

  const modelPicker = page.locator(".zero-composer").getByRole("combobox");
  await modelPicker.click();
  await page.getByRole("option", { name: /^Claude Sonnet 5\b/ }).click();
  await expect(
    page
      .locator(".zero-composer")
      .getByRole("combobox", { name: "Claude Sonnet 5", exact: true }),
  ).toBeVisible();

  await page.locator('input[type="file"]').first().setInputFiles({
    name: attachmentName,
    mimeType: "image/png",
    buffer: attachmentImage,
  });
  await expect(page.getByLabel(`Remove ${attachmentName}`)).toBeVisible({
    timeout: 20_000,
  });

  const prompt = "printf 'Hello from Zero.\\n'";
  await composer.fill(prompt);
  const [sendRequest] = await Promise.all([
    page.waitForRequest((request) => {
      return (
        request.method() === "POST" &&
        request.url() === new URL("/api/zero/chat/events", apiUrl).toString()
      );
    }),
    page.getByRole("button", { name: "Send", exact: true }).click(),
  ]);

  const sendBody: unknown = JSON.parse(sendRequest.postData() ?? "null");
  expect(sendBody).toMatchObject({ realAgentInPreview: false });

  const userMessage = page.locator('[data-role="user"]').last();
  await expect(userMessage.getByText(prompt, { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  const attachmentLink = userMessage.getByRole("link", {
    name: `Preview ${attachmentName}`,
  });
  await expect(attachmentLink).toBeVisible();
  const attachmentUrl = await attachmentLink.getAttribute("href");
  if (attachmentUrl === null) {
    throw new Error("Uploaded attachment URL is unavailable");
  }
  const attachmentResponse = await page.request.get(
    new URL(attachmentUrl, appUrl).toString(),
  );
  expect(attachmentResponse.status()).toBe(200);
  expect(attachmentResponse.headers()["content-type"]).toContain("image/png");

  const assistantReply = page
    .locator('[data-role="assistant"]:not([data-thinking-indicator])')
    .locator(".zero-chat-bubble-assistant")
    .filter({ hasText: /\S/u })
    .last();
  await expect(assistantReply).toBeVisible({ timeout: 120_000 });
  await expect(assistantReply).not.toContainText("Oops, something went wrong");
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeVisible();
});
