import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  chromium,
  expect as playwrightExpect,
  type Page,
} from "@playwright/test";
import { seedPreviewBypassCookie } from "../lib/preview-bypass";
import { fixtureBootstrap } from "./bootstrap";
import { browserArgs, stableScreenshot } from "./capture";
import { compareImages, roundingTolerance, sha256 } from "./images";

const expect = playwrightExpect.configure({ timeout: 30_000 });
interface VisualCase {
  id: string;
  path: string;
  surface: "providers" | "connectors";
  theme: "light" | "dark";
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  hasTouch: boolean;
  isMobile: boolean;
}
interface Capture {
  id: string;
  image: string;
  sha256: string;
  observation: unknown;
  status: "BASELINE" | "PASS" | "FAIL";
  changedPixels?: number;
  contentChangedPixels?: number;
  roundingPixels?: number;
}
interface Manifest {
  version: 1;
  protocol: "channel-rounding-v1";
  sourceSha: string;
  appBuildSha: string;
  apiBuildSha: string;
  appOrigin: string;
  apiOrigin: string;
  browser: string;
  runnerSha256: string;
  caseSha256: string;
  fixtureSha256: string;
  roundingTolerance: typeof roundingTolerance;
  cases: VisualCase[];
  captures: Capture[];
  failures: string[];
  apiPaths: string[];
}
const { values } = parseArgs({
  options: {
    "app-url": { type: "string" },
    "api-url": { type: "string" },
    "expected-build": { type: "string" },
    "api-build": { type: "string" },
    "source-sha": { type: "string" },
    "storage-state": { type: "string" },
    "executable-path": { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
  },
});
function required(key: keyof typeof values) {
  const value = values[key];
  assert(value, `--${key} is required`);
  return value;
}
function origin(value: string) {
  const url = new URL(value);
  assert.equal(url.protocol, "https:");
  assert(!url.username && !url.password && !url.search && !url.hash);
  assert.equal(url.pathname, "/");
  return url.origin;
}
async function observe(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img, [role="img"]'))
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const style = getComputedStyle(element),
          box = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          role: element.getAttribute("role"),
          alt: element.getAttribute("alt"),
          label: element.getAttribute("aria-label"),
          hidden: element.hasAttribute("hidden"),
          source: element
            .getAttribute("src")
            ?.startsWith("https://img.clerk.com/")
            ? "isolated-test-avatar"
            : element.getAttribute("src"),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          darkAncestor: Boolean(
            element.parentElement?.closest('[data-theme="dark"]'),
          ),
          themeOnSelf: element.getAttribute("data-theme"),
          portal: Boolean(
            element.closest(
              '[data-base-ui-portal], [data-slot="popover-content"], [data-slot="select-content"]',
            ),
          ),
          styles: Object.fromEntries(
            [
              "filter",
              "width",
              "height",
              "max-width",
              "max-height",
              "display",
              "object-fit",
              "transform",
              "opacity",
              "color",
              "overflow",
              "flex-shrink",
            ].map((property) => [property, style.getPropertyValue(property)]),
          ),
        };
      }),
  );
}
// The shared helper deliberately rejects failed image decoding. This fault-only
// capture keeps the actual broken image and fallback DOM, waits for every other
// image/font/animation, and requires the same three identical unmasked frames.
async function captureBrokenIcon(page: Page): Promise<Buffer> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      Array.from(document.images).map(async (image) => {
        if (image.currentSrc.endsWith("/icon-broken.svg")) {
          if (!image.complete || image.naturalWidth !== 0 || !image.hidden)
            throw new Error("Expected hidden failed image");
        } else if (image.currentSrc) await image.decode();
      }),
    );
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().iterations === Infinity) {
        animation.pause();
        animation.currentTime = 0;
      }
    }
  });
  let previous: Buffer | undefined,
    consecutive = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const bytes = await page.screenshot({ fullPage: true, caret: "initial" });
    consecutive = previous?.equals(bytes) ? consecutive + 1 : 1;
    if (consecutive === 3) return bytes;
    previous = bytes;
  }
  throw new Error(
    "Failed-icon page did not produce three identical painted frames",
  );
}
async function run() {
  const appOrigin = origin(required("app-url")),
    apiOrigin = origin(required("api-url"));
  assert.notEqual(appOrigin, apiOrigin);
  const sourceSha = required("source-sha"),
    appBuildSha = required("expected-build"),
    apiBuildSha = required("api-build");
  for (const sha of [sourceSha, appBuildSha, apiBuildSha])
    assert(/^[a-f0-9]{40}$/.test(sha));
  const out = path.resolve(required("out"));
  const caseBytes = await readFile(
    path.join(__dirname, "icon-mono-cases.json"),
  );
  const fixtureBytes = await readFile(
    path.join(__dirname, "icon-mono-fixtures.json"),
  );
  const fixture: Record<string, unknown> = JSON.parse(fixtureBytes.toString());
  const caseFile: { version: number; cases: VisualCase[] } = JSON.parse(
    caseBytes.toString(),
  );
  assert.equal(caseFile.version, 1);
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all(
        [
          __filename,
          path.join(__dirname, "capture.ts"),
          path.join(__dirname, "images.ts"),
          path.join(__dirname, "bootstrap.ts"),
          path.join(__dirname, "../lib/preview-bypass.ts"),
          path.join(__dirname, "../../pnpm-lock.yaml"),
        ].map((file) => readFile(file)),
      ),
    ),
  );
  const baseline: Manifest | undefined = values.baseline
    ? JSON.parse(
        await readFile(path.join(values.baseline, "manifest.json"), "utf8"),
      )
    : undefined;
  if (baseline) {
    assert.equal(baseline.protocol, "channel-rounding-v1");
    assert.equal(baseline.runnerSha256, runnerSha256, "Frozen runner changed");
    assert.equal(
      baseline.caseSha256,
      sha256(caseBytes),
      "Frozen cases changed",
    );
    assert.equal(
      baseline.fixtureSha256,
      sha256(fixtureBytes),
      "Frozen fixture changed",
    );
    assert.deepEqual(baseline.roundingTolerance, roundingTolerance);
    assert.deepEqual(baseline.failures, [], "Cannot accept a failed baseline");
  }
  await mkdir(out);
  const browser = await chromium.launch({
    executablePath: values["executable-path"],
    args: browserArgs,
  });
  const manifest: Manifest = {
    version: 1,
    protocol: "channel-rounding-v1",
    sourceSha,
    appBuildSha,
    apiBuildSha,
    appOrigin,
    apiOrigin,
    browser: browser.version(),
    runnerSha256,
    caseSha256: sha256(caseBytes),
    fixtureSha256: sha256(fixtureBytes),
    roundingTolerance,
    cases: caseFile.cases,
    captures: [],
    failures: [],
    apiPaths: [],
  };
  await writeFile(
    path.join(out, "run-start.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  try {
    if (baseline)
      assert.equal(baseline.browser, manifest.browser, "Browser changed");
    for (const item of caseFile.cases) {
      const context = await browser.newContext({
        storageState: required("storage-state"),
        viewport: item.viewport,
        deviceScaleFactor: item.deviceScaleFactor,
        hasTouch: item.hasTouch,
        isMobile: item.isMobile,
        colorScheme: item.theme,
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      try {
        await context.clearCookies({ name: "__Secure-okou-theme" });
        await context.addCookies([
          {
            name: "__Secure-okou-theme",
            value: `v1.${item.theme}`,
            url: appOrigin,
            secure: true,
            sameSite: "Lax",
          },
        ]);
        await seedPreviewBypassCookie(context, appOrigin);
        await seedPreviewBypassCookie(context, apiOrigin);
        let brokenIcon = false;
        const assets = fixture._iconAssets as Record<string, string>;
        await page.route("https://icons.example.test/**", async (route) => {
          const url = route.request().url();
          const body = assets[url];
          assert(body, "Unknown synthetic icon request");
          if (brokenIcon && url.endsWith("/icon-broken.svg")) {
            await route.fulfill({
              status: 404,
              contentType: "text/plain",
              body: "Intentional icon fixture failure",
            });
          } else await route.fulfill({ contentType: "image/svg+xml", body });
        });
        const responses = {
          ...fixture,
          "/api/user-preferences": {
            ...(fixture["/api/user-preferences"] as object),
            theme: item.theme,
          },
        };
        await fixtureBootstrap(page, appOrigin, () => responses);
        await page.route(
          (url) => url.origin === apiOrigin,
          async (route) => {
            const request = route.request(),
              url = new URL(request.url());
            if (!manifest.apiPaths.includes(url.pathname))
              manifest.apiPaths.push(url.pathname);
            const response: unknown = Reflect.get(responses, url.pathname);
            if (url.pathname === "/api/attribution/google-ads-account") {
              await route.fulfill({ json: { googleAdsAccountId: null } });
              return;
            }
            if (url.pathname === "/api/attribution/signup") {
              await route.fulfill({
                json: { recorded: true, googleAdsAccountId: null },
              });
              return;
            }
            if (
              request.method() === "POST" &&
              url.pathname === "/api/user-preferences"
            ) {
              const update: Record<string, unknown> = request.postDataJSON();
              for (const [key, value] of Object.entries(update))
                assert.deepEqual(
                  value,
                  Reflect.get(responses["/api/user-preferences"], key),
                );
            } else if (
              request.method() !== "GET" &&
              request.method() !== "OPTIONS"
            ) {
              manifest.failures.push(
                `${item.id}: prohibited ${request.method()} ${url.pathname}`,
              );
              await route.abort();
              return;
            }
            if (response !== undefined) {
              await route.fulfill({
                json: response,
                status:
                  (fixture._statusCodes as Record<string, number>)[
                    url.pathname
                  ] ?? 200,
              });
              return;
            }
            const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
            await route.continue({
              headers: {
                ...request.headers(),
                ...(secret ? { "x-vercel-protection-bypass": secret } : {}),
              },
            });
          },
        );
        await page.goto(new URL(item.path, appOrigin).href, {
          waitUntil: "domcontentloaded",
        });
        await expect(
          page.locator('meta[name="okou-app-git-commit-sha"]'),
        ).toHaveAttribute("content", appBuildSha);
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          item.theme,
        );
        async function capture(state: string, expectedBrokenIcon = false) {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`,
            image = `${id}.png`;
          const monoImages = page.locator(
            'img[src*="openai-"], img[src*="okou-logo-mark-dark-"], img[src="https://icons.example.test/icon-mono.svg"]',
          );
          for (const icon of await monoImages.all()) {
            await expect(icon).toHaveCSS(
              "filter",
              item.theme === "dark" ? "invert(1)" : "none",
            );
            assert.equal(
              await icon.getAttribute("data-theme"),
              null,
              "Theme must remain on an ancestor",
            );
          }
          for (const icon of await page
            .locator(
              'img[src*="claude-code-"], img[src*="deepseek-"], img[src="https://icons.example.test/icon-color.svg"]',
            )
            .all()) {
            await expect(icon).toHaveCSS("filter", "none");
          }
          if (state === "portaled-options") {
            assert(
              await page
                .getByRole("listbox")
                .evaluate((element) =>
                  Boolean(element.closest("[data-base-ui-portal]")),
                ),
              "Options must use a real portal",
            );
          }
          await page.mouse.move(0, 0);
          // Invalidate cached narrow-DPR text-decoration raster after dialogs settle.
          // Restore the exact case viewport before measuring; no DOM or CSS changes.
          await page.setViewportSize({
            ...item.viewport,
            width: item.viewport.width + 1,
          });
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          await page.setViewportSize(item.viewport);
          await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
          const bytes = expectedBrokenIcon
              ? await captureBrokenIcon(page)
              : await stableScreenshot(page),
            observation = await observe(page);
          await writeFile(path.join(out, image), bytes, { flag: "wx" });
          const record: Capture = {
            id,
            image,
            sha256: sha256(bytes),
            observation,
            status: "BASELINE",
          };
          if (baseline && values.baseline) {
            const reference = baseline.captures.find(
              (entry) => entry.id === id,
            );
            assert(reference, `Missing ${id}`);
            assert.equal(reference.image, image);
            const before = await readFile(path.join(values.baseline, image));
            assert.equal(sha256(before), reference.sha256);
            const result = compareImages(before, bytes);
            record.changedPixels = result.changedPixels;
            record.contentChangedPixels = result.contentChangedPixels;
            record.roundingPixels = result.roundingPixels;
            const observationsEqual =
              JSON.stringify(reference.observation) ===
              JSON.stringify(observation);
            record.status =
              result.contentChangedPixels === 0 && observationsEqual
                ? "PASS"
                : "FAIL";
            await writeFile(path.join(out, `${id}-before.png`), before, {
              flag: "wx",
            });
            await writeFile(path.join(out, `${id}-diff.png`), result.diff, {
              flag: "wx",
            });
            if (record.status === "FAIL")
              manifest.failures.push(
                `${id}: ${result.contentChangedPixels} content pixels; observationsEqual=${observationsEqual}`,
              );
          }
          manifest.captures.push(record);
          await appendFile(
            path.join(out, "captures.jsonl"),
            JSON.stringify(record) + "\n",
          );
          console.log(`${id}: ${record.status} ${record.changedPixels ?? ""}`);
        }
        if (item.surface === "providers") {
          await expect(
            page.getByRole("dialog", { name: "Settings", exact: true }),
          ).toBeVisible();
          const dialog = page.getByRole("dialog", {
            name: "Settings",
            exact: true,
          });
          const personal = dialog.getByRole("heading", {
            name: "Personal",
            exact: true,
          });
          await expect(
            dialog.locator('img[src*="claude-code-"]'),
          ).toBeAttached();
          await expect(
            dialog.locator('img[src*="openai-"]').last(),
          ).toBeAttached();
          const picker = dialog
            .getByRole("combobox")
            .filter({ hasText: "DeepSeek V4 Pro" });
          await expect(picker).toBeVisible();
          await capture("models");
          await picker.click();
          const list = page.getByRole("listbox");
          await expect(list).toBeVisible();
          await expect(list.locator("img")).toHaveCount(3);
          await capture("portaled-options");
          await page.keyboard.press("Escape");
          await expect(list).not.toBeVisible();
          await personal.scrollIntoViewIfNeeded();
          await dialog
            .locator('img[src*="claude-code-"]')
            .scrollIntoViewIfNeeded();
          await expect(
            dialog.locator('img[src*="claude-code-"]'),
          ).toBeInViewport({ ratio: 1 });
          await expect(
            dialog.locator('img[src*="openai-"]').last(),
          ).toBeInViewport({ ratio: 1 });
          await capture("personal");
        } else {
          await expect(
            page.getByText("Icon Mono", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("Icon Color", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("img", {
              name: "Connector icon unavailable",
              exact: true,
            }),
          ).toBeVisible();
          await capture("page");
          brokenIcon = true;
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(
            page.locator(
              'img[src="https://icons.example.test/icon-broken.svg"]',
            ),
          ).toHaveAttribute("hidden", "");
          await expect(
            page.getByRole("img", {
              name: "Connector icon unavailable",
              exact: true,
            }),
          ).toHaveCount(2);
          await capture("failed-image", true);
        }
      } catch (error) {
        const failure = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        manifest.failures.push(failure);
        console.error(failure);
        await page.screenshot({
          path: path.join(out, `${item.id}-failure.png`),
          fullPage: true,
        });
        await writeFile(
          path.join(out, `${item.id}-failure.txt`),
          await page.locator("body").innerText(),
          { flag: "wx" },
        );
      } finally {
        await context.close();
      }
    }
    if (baseline)
      assert.equal(manifest.captures.length, baseline.captures.length);
  } finally {
    await writeFile(
      path.join(out, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx" },
    );
    await browser.close();
  }
  assert.equal(
    manifest.failures.length,
    0,
    "Visual acceptance failed; all evidence retained",
  );
}
void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
