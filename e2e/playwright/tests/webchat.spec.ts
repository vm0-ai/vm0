import type { Locator, Page, Route } from "@playwright/test";

import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);
const layoutShiftImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type MediaKind = "attachment" | "markdown";

async function fulfillLayoutShiftImage(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    body: layoutShiftImage,
    headers: {
      "access-control-allow-origin": appUrl,
      "cache-control": "no-store",
      "content-type": "image/png",
    },
  });
}

async function layoutSnapshot(
  root: Locator,
  elements: readonly Locator[],
): Promise<{
  root: { width: number; height: number };
  elements: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    bottom: number;
  }>;
}> {
  const rootBounds = await root.boundingBox();
  if (rootBounds === null) {
    throw new Error("Layout root bounds are unavailable");
  }

  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    root: {
      width: round(rootBounds.width),
      height: round(rootBounds.height),
    },
    elements: await Promise.all(
      elements.map(async (element) => {
        const bounds = await element.boundingBox();
        if (bounds === null) {
          throw new Error("Layout element bounds are unavailable");
        }
        const x = bounds.x - rootBounds.x;
        const y = bounds.y - rootBounds.y;
        return {
          x: round(x),
          y: round(y),
          width: round(bounds.width),
          height: round(bounds.height),
          bottom: round(y + bounds.height),
        };
      }),
    ),
  };
}

async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    });
  });
}

async function elementHeight(locator: Locator): Promise<number> {
  const bounds = await locator.boundingBox();
  if (bounds === null) {
    throw new Error("Composer bounds are unavailable");
  }
  return bounds.height;
}

test("send a chat message, preserve media layout, cap long drafts, and preserve template height", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const pendingImageRoutes: Record<MediaKind, Route[]> = {
    attachment: [],
    markdown: [],
  };
  const releasedImages = new Set<MediaKind>();

  await page.route("**/*layout-shift*.png*", async (route) => {
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
      // Preview deployments use a per-commit origin that storage cannot
      // pre-allow. Proxy the signed PUT outside browser CORS while preserving
      // the real write needed by the runner.
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
    if (method !== "GET") {
      await route.continue();
      return;
    }

    const requestUrl = route.request().url();
    const kind: MediaKind = requestUrl.includes("markdown-layout-shift.png")
      ? "markdown"
      : "attachment";
    // The composer loads the raw attachment URL before the message is sent.
    // Fulfill that distinct request immediately; hold only the transformed
    // chat-card URL whose loading transition is under test.
    if (kind === "attachment" && !requestUrl.includes("/cdn-cgi/image/")) {
      await fulfillLayoutShiftImage(route);
      return;
    }
    if (releasedImages.has(kind)) {
      await fulfillLayoutShiftImage(route);
      return;
    }
    pendingImageRoutes[kind].push(route);
  });

  const releaseImages = async (kind: MediaKind): Promise<void> => {
    releasedImages.add(kind);
    await Promise.all(
      pendingImageRoutes[kind]
        .splice(0)
        .map(async (route) => fulfillLayoutShiftImage(route)),
    );
  };

  // Navigate to chat page (default agent)
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  // Wait for composer to be ready. Since the workflow cutover
  // (vm0-ai/vm0#19959) the composer is a tiptap contenteditable: the
  // placeholder is an overlay div, not a textarea attribute.
  await expect(page.getByText(/Ask me to automate/)).toBeVisible({
    timeout: 20_000,
  });
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // Own the runner precondition instead of relying on the workspace default.
  // CI's mock Codex echoes the prompt verbatim, including attachment context.
  const modelPicker = page.locator(".zero-composer").getByRole("combobox");
  await modelPicker.click();
  await page.getByRole("option", { name: /^GPT 5\.6 Luna\b/ }).click();
  await expect(
    page
      .locator(".zero-composer")
      .getByRole("combobox", { name: "GPT 5.6 Luna", exact: true }),
  ).toBeVisible();

  // Send a message with an image attachment. Mock Codex echoes the plain-text
  // prompt and renders its second image URL in the assistant's Markdown.
  const marker = `e2e-${Date.now()}`;
  const afterMediaMarker = `after-media-${Date.now()}`;
  const markdownImageUrl =
    "https://layout-shift.test/markdown-layout-shift.png";
  const prompt = `${marker}\n\n${markdownImageUrl}\n\n${afterMediaMarker}`;
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "attachment-layout-shift.png",
    mimeType: "image/png",
    buffer: layoutShiftImage,
  });
  await expect(
    page.getByLabel("Remove attachment-layout-shift.png"),
  ).toBeVisible({ timeout: 20_000 });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // Verify user message appears
  const userMessage = page.locator('[data-role="user"]').last();
  await expect(userMessage.getByText(marker, { exact: false })).toBeVisible({
    timeout: 10_000,
  });

  // Hold the image response at the browser boundary and compare the visible
  // attachment card, its row, the following text, and their containing message.
  const attachmentPreview = page
    .getByRole("link", {
      name: "Preview attachment-layout-shift.png",
    })
    .last();
  await expect(attachmentPreview).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() => pendingImageRoutes.attachment.length)
    .toBeGreaterThan(0);
  const attachmentRow = attachmentPreview.locator("xpath=..");
  const attachmentText = userMessage.getByText(marker, { exact: false });
  const attachmentBefore = await layoutSnapshot(userMessage, [
    attachmentPreview,
    attachmentRow,
    attachmentText,
  ]);
  await releaseImages("attachment");
  await expect
    .poll(() =>
      attachmentPreview
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await waitForTwoFrames(page);
  expect(
    await layoutSnapshot(userMessage, [
      attachmentPreview,
      attachmentRow,
      attachmentText,
    ]),
  ).toEqual(attachmentBefore);

  // Wait for assistant response — 120s because the full pipeline runs:
  // runner picks up job → starts VM sandbox → mock Codex echoes → response streams back.
  // Requires USE_MOCK_CODEX=true in CI. Expected latency: 60–90s.
  const assistantMessage = page.locator('[data-role="assistant"]').last();
  const afterMedia = assistantMessage.getByText(afterMediaMarker);
  await expect(afterMedia).toBeVisible({ timeout: 120_000 });

  // Repeat the delayed-response geometry check for an assistant Markdown image.
  const markdownPreview = assistantMessage.getByRole("button", {
    name: "markdown-layout-shift.png",
  });
  await expect(markdownPreview).toBeVisible();
  await expect
    .poll(() => pendingImageRoutes.markdown.length)
    .toBeGreaterThan(0);
  const markdownParagraph = markdownPreview.locator("xpath=..");
  const markdownBefore = await layoutSnapshot(assistantMessage, [
    markdownPreview,
    markdownParagraph,
    afterMedia,
  ]);
  await releaseImages("markdown");
  await expect
    .poll(() =>
      markdownPreview
        .locator("img")
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await waitForTwoFrames(page);
  expect(
    await layoutSnapshot(assistantMessage, [
      markdownPreview,
      markdownParagraph,
      afterMedia,
    ]),
  ).toEqual(markdownBefore);

  // The completed run leaves us on a chat-thread composer, whose responsive
  // minimum height is two lines on mobile and three lines on desktop.
  await expect.poll(() => elementHeight(composer)).toBe(96);

  const longDraft = Array.from(
    { length: 40 },
    (_, index) => `draft line ${index + 1}`,
  ).join("\n");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await composer.fill(longDraft);
  await expect.poll(() => elementHeight(composer)).toBe(320);
  await expect
    .poll(() =>
      composer.evaluate(
        (element) => element.scrollHeight > element.clientHeight,
      ),
    )
    .toBe(true);
  await composer.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() => composer.evaluate((element) => element.scrollTop > 0))
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 600 });
  await expect.poll(() => elementHeight(composer)).toBe(240);

  await composer.fill("");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect.poll(() => elementHeight(composer)).toBe(96);

  await page.getByRole("button", { name: "Template", exact: true }).click();
  await page
    .getByRole("button", { name: /^Select template / })
    .first()
    .click();

  await expect.poll(() => elementHeight(composer)).toBe(134);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => elementHeight(composer)).toBe(106);

  await page.getByRole("button", { name: /^Remove template / }).click();
  await expect.poll(() => elementHeight(composer)).toBe(68);
});
