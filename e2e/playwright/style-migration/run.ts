import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  chromium,
  expect as playwrightExpect,
  type Locator,
  type Page,
} from "@playwright/test";

import { seedPreviewBypassCookie } from "../lib/preview-bypass";
import { compareImages, roundingTolerance, sha256 } from "./images";

const expect = playwrightExpect.configure({ timeout: 30_000 });

interface VisualCase {
  id: string;
  path: string;
  theme: "light" | "dark";
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  hasTouch?: boolean;
  isMobile?: boolean;
}

interface Capture {
  id: string;
  image: string;
  sha256: string;
  observation: unknown;
  changedPixels?: number;
  contentChangedPixels?: number;
  roundingPixels?: number;
  status: "BASELINE" | "PASS" | "FAIL";
}

interface Manifest {
  version: 1;
  protocol: "channel-rounding-v1";
  caseSha256: string;
  runnerSha256: string;
  roundingTolerance: typeof roundingTolerance;
  sourceSha: string;
  appBuildSha: string;
  appOrigin: string;
  apiOrigin: string;
  browser: string;
  captures: Capture[];
  cases: VisualCase[];
  failures: string[];
}

const { values } = parseArgs({
  options: {
    "app-url": { type: "string" },
    "api-url": { type: "string" },
    "expected-build": { type: "string" },
    "source-sha": { type: "string" },
    "storage-state": { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    "executable-path": { type: "string" },
  },
});

function required(name: keyof typeof values): string {
  const value = values[name];
  assert(value, `--${name} is required`);
  return value;
}

function origin(value: string): string {
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Use an actual deployed HTTPS origin");
  assert(!url.username && !url.password && !url.search && !url.hash);
  assert.equal(url.pathname, "/", "Pass origins, not routes or bypass URLs");
  return url.origin;
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function stableScreenshot(page: Page): Promise<Buffer> {
  await page.evaluate(async () => {
    await document.fonts.ready;
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
  let previous: Buffer | undefined;
  let consecutive = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await frames(page);
    const image = await page.screenshot({ fullPage: true, caret: "initial" });
    consecutive = previous?.equals(image) ? consecutive + 1 : 1;
    if (consecutive === 3) return image;
    previous = image;
  }
  throw new Error(
    "Three identical painted frames were not observed; baseline is not stable",
  );
}

async function observe(dialog: Locator) {
  return dialog.evaluate((element) => {
    const properties = [
      "background-color",
      "background-image",
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "border-top-color",
      "border-top-style",
      "border-radius",
      "box-shadow",
      "color",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "padding",
      "gap",
      "opacity",
      "outline",
      "outline-offset",
      "overflow",
    ];
    return Array.from(element.querySelectorAll("button[aria-pressed]")).map(
      (control) => {
        const box = control.getBoundingClientRect();
        const style = getComputedStyle(control);
        return {
          tag: control.tagName,
          text: control.textContent?.trim(),
          pressed: control.getAttribute("aria-pressed"),
          disabled: control.hasAttribute("disabled"),
          focused: document.activeElement === control,
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          styles: Object.fromEntries(
            properties.map((property) => [
              property,
              style.getPropertyValue(property),
            ]),
          ),
        };
      },
    );
  });
}

async function run() {
  const appOrigin = origin(required("app-url"));
  const apiOrigin = origin(required("api-url"));
  assert.notEqual(
    appOrigin,
    apiOrigin,
    "Use the deployment's App and API aliases; bare Worker version hosts cannot resolve the API",
  );
  const appBuildSha = required("expected-build");
  const sourceSha = required("source-sha");
  for (const sha of [appBuildSha, sourceSha])
    assert(/^[a-f0-9]{40}$/.test(sha));
  const out = path.resolve(required("out"));
  const caseBytes = await readFile(path.join(__dirname, "cases.json"));
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all([
        readFile(__filename),
        readFile(path.join(__dirname, "images.ts")),
        readFile(path.join(__dirname, "../lib/preview-bypass.ts")),
        readFile(path.join(__dirname, "../../pnpm-lock.yaml")),
      ]),
    ),
  );
  const caseFile: { version: number; cases: VisualCase[] } = JSON.parse(
    caseBytes.toString(),
  );
  assert.equal(caseFile.version, 1);
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
    assert.deepEqual(baseline.failures, [], "Cannot accept a failed baseline");
  }
  // Deliberately exclusive: no command can replace a frozen archive or failed attempt.
  await mkdir(out);
  const browser = await chromium.launch({
    executablePath: values["executable-path"],
    args: [
      "--disable-gpu",
      "--force-color-profile=srgb",
      "--deterministic-mode",
    ],
  });
  const manifest: Manifest = {
    version: 1,
    protocol: "channel-rounding-v1",
    caseSha256: sha256(caseBytes),
    runnerSha256,
    roundingTolerance,
    sourceSha,
    appBuildSha,
    appOrigin,
    apiOrigin,
    browser: browser.version(),
    captures: [],
    cases: caseFile.cases,
    failures: [],
  };
  try {
    if (baseline)
      assert.equal(
        baseline.browser,
        manifest.browser,
        "Browser version changed",
      );
    for (const item of caseFile.cases) {
      assert(/^[a-z0-9-]+$/.test(item.id));
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
      let releaseSave: (() => void) | undefined;
      try {
        // The shell's first paint prefers this cookie over localStorage.
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
        await context.addInitScript(
          ({ theme }) => {
            localStorage.setItem("theme", theme);
            localStorage.setItem("colorTheme", "blue-horizon");
          },
          { theme: item.theme },
        );
        await seedPreviewBypassCookie(context, appOrigin);
        await seedPreviewBypassCookie(context, apiOrigin);
        const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        if (bypassSecret) {
          await context.route(
            (url) => url.origin === apiOrigin,
            async (route) => {
              await route.continue({
                headers: {
                  ...route.request().headers(),
                  "x-vercel-protection-bypass": bypassSecret,
                },
              });
            },
          );
        }
        const page = await context.newPage();
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === apiOrigin && response.status() >= 400) {
            manifest.failures.push(
              `${item.id}: API HTTP ${response.status()} ${url.pathname}`,
            );
          }
        });
        page.setDefaultTimeout(30_000);
        const preferences = {
          timezone: "UTC",
          locale: "en-US",
          translationLanguage: "en",
          supportedLocales: ["en-US"],
          pinnedAgentIds: [],
          sendMode: "enter",
          cloudBrowserEnabledByDefault: true,
          theme: item.theme,
          colorTheme: "blue-horizon",
          captureNetworkBodiesRemaining: 0,
          voiceInputModel: null,
        };
        let savePending: Promise<void> | undefined;
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            url.pathname === "/api/user-preferences",
          async (route) => {
            try {
              if (route.request().method() === "POST") {
                const update: Record<string, unknown> = route
                  .request()
                  .postDataJSON();
                for (const [key, value] of Object.entries(update)) {
                  if (key === "sendMode") {
                    assert(value === "cmd-enter" || value === "enter");
                  } else {
                    assert(
                      Object.hasOwn(preferences, key),
                      `Unexpected preference: ${key}`,
                    );
                    assert.deepEqual(
                      value,
                      Reflect.get(preferences, key),
                      `Fixture changed: ${key}`,
                    );
                  }
                }
                if (update.sendMode !== undefined) {
                  assert(
                    update.sendMode === "enter" ||
                      update.sendMode === "cmd-enter",
                  );
                  if (savePending) await savePending;
                  preferences.sendMode = update.sendMode;
                }
              } else assert.equal(route.request().method(), "GET");
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(preferences),
              });
            } catch (error) {
              manifest.failures.push(
                `${item.id}: preference fixture: ${error instanceof Error ? error.message : String(error)}`,
              );
              await route.fulfill({
                status: 500,
                body: "Preference fixture rejected the request",
              });
            }
          },
        );
        await page.goto(new URL(item.path, appOrigin).href, {
          waitUntil: "domcontentloaded",
        });
        await expect(
          page.locator('meta[name="okou-app-git-commit-sha"]'),
        ).toHaveAttribute("content", appBuildSha);
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        const light = dialog.getByRole("button", {
          name: "Light",
          exact: true,
        });
        const dark = dialog.getByRole("button", { name: "Dark", exact: true });
        await expect(item.theme === "light" ? light : dark).toHaveAttribute(
          "aria-pressed",
          "true",
        );

        async function capture(state: string) {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          const bytes = await stableScreenshot(page);
          const observation = await observe(dialog);
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
            assert(reference, `Missing baseline case ${id}`);
            assert.equal(
              reference.image,
              image,
              `Unexpected baseline filename: ${id}`,
            );
            const before = await readFile(
              path.join(values.baseline, reference.image),
            );
            assert.equal(
              sha256(before),
              reference.sha256,
              `Baseline image changed: ${id}`,
            );
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
                `${id}: ${result.contentChangedPixels} content pixels, ${result.roundingPixels} rounding pixels; observationsEqual=${observationsEqual}`,
              );
          }
          manifest.captures.push(record);
          console.log(
            `${id}: ${record.status}${record.changedPixels === undefined ? "" : ` (${record.contentChangedPixels} content pixels, ${record.roundingPixels} rounding pixels)`}`,
          );
        }

        await light.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("appearance");
        const inactive = item.theme === "light" ? dark : light;
        await inactive.hover();
        await capture("appearance-hover");
        await page.mouse.move(0, 0);
        await light.focus();
        await page.keyboard.press("Tab");
        await expect(dark).toBeFocused();
        await capture("appearance-focus");

        const enter = dialog.getByRole("button", {
          name: "Enter",
          exact: true,
        });
        const commandEnter = dialog.getByRole("button", {
          name: /^(Cmd|Ctrl|⌘).*Enter$/,
        });
        await expect(enter).toHaveAttribute("aria-pressed", "true");
        await enter.scrollIntoViewIfNeeded();
        await enter.click();
        await expect(enter).toBeEnabled();
        await page.mouse.move(0, 0);
        await capture("send-mode");
        await commandEnter.hover();
        await capture("send-hover");
        savePending = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        await commandEnter.click();
        await expect(enter).toBeDisabled();
        await expect(commandEnter).toHaveAttribute("aria-pressed", "true");
        await page.mouse.move(0, 0);
        await capture("send-saving");
        releaseSave?.();
        savePending = undefined;
        await expect(commandEnter).toBeEnabled();
        await expect(commandEnter).toHaveAttribute("aria-pressed", "true");
        await capture("send-saved");
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      } catch (error) {
        const failure = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        manifest.failures.push(failure);
        console.error(failure);
      } finally {
        releaseSave?.();
        await context.close();
      }
    }
    if (baseline)
      assert.equal(
        manifest.captures.length,
        baseline.captures.length,
        "Not every frozen case was replayed",
      );
  } finally {
    await browser.close();
    await writeFile(
      path.join(out, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  assert.equal(manifest.failures.length, 0, manifest.failures.join("\n"));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
