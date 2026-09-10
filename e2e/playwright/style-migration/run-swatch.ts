import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  chromium,
  expect as playwrightExpect,
  type Locator,
} from "@playwright/test";

import { seedPreviewBypassCookie } from "../lib/preview-bypass";
import { compareImages, roundingTolerance, sha256 } from "./images";
import { browserArgs, stableScreenshot } from "./capture";
import { fixtureBootstrap } from "./bootstrap";

const expect = playwrightExpect.configure({ timeout: 30_000 });

interface VisualCase {
  id: string;
  path: string;
  theme: "light" | "dark";
  enabled: boolean;
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
  fixtureSha256: string;
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
    "feature-fixture": { type: "string" },
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
    return Array.from(
      element.querySelectorAll("button[aria-pressed], span[data-color-theme]"),
    ).map((control) => {
      const box = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return {
        tag: control.tagName,
        colorTheme: control.getAttribute("data-color-theme"),
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
    });
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
  const caseBytes = await readFile(path.join(__dirname, "swatch-cases.json"));
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all([
        readFile(__filename),
        readFile(path.join(__dirname, "images.ts")),
        readFile(path.join(__dirname, "capture.ts")),
        readFile(path.join(__dirname, "bootstrap.ts")),
        readFile(path.join(__dirname, "../lib/preview-bypass.ts")),
        readFile(path.join(__dirname, "../../pnpm-lock.yaml")),
      ]),
    ),
  );
  const fixtureBytes = await readFile(required("feature-fixture"));
  const fixture: {
    switches: Record<string, boolean>;
    effectiveSwitches: Record<string, boolean>;
  } = JSON.parse(fixtureBytes.toString());
  assert(fixture.switches && fixture.effectiveSwitches);
  const caseFile: {
    version: number;
    cases: VisualCase[];
    palettes: { value: string; label: string }[];
  } = JSON.parse(caseBytes.toString());
  assert.equal(caseFile.version, 1);
  const baseline: Manifest | undefined = values.baseline
    ? JSON.parse(
        await readFile(path.join(values.baseline, "manifest.json"), "utf8"),
      )
    : undefined;
  if (baseline) {
    assert.equal(baseline.protocol, "channel-rounding-v1");
    assert.equal(
      baseline.fixtureSha256,
      sha256(fixtureBytes),
      "Frozen features changed",
    );
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
    args: browserArgs,
  });
  const manifest: Manifest = {
    version: 1,
    protocol: "channel-rounding-v1",
    fixtureSha256: sha256(fixtureBytes),
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
      try {
        // Theme bootstrap and runtime share this cookie.
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
        const features = {
          ...fixture,
          switches: { ...fixture.switches, gradientColorThemes: item.enabled },
          effectiveSwitches: {
            ...fixture.effectiveSwitches,
            gradientColorThemes: item.enabled,
          },
        };
        await fixtureBootstrap(page, appOrigin, () => ({
          "/api/user-preferences": preferences,
          "/api/feature-switches": features,
        }));
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            url.pathname === "/api/feature-switches",
          async (route) => {
            assert.equal(route.request().method(), "GET");
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(features),
            });
          },
        );
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
                  if (key === "colorTheme") {
                    assert(
                      caseFile.palettes.some(
                        (palette) => palette.value === value,
                      ),
                    );
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
                if (update.colorTheme !== undefined) {
                  assert(typeof update.colorTheme === "string");
                  preferences.colorTheme = update.colorTheme;
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
        await expect(page.locator("html")).toHaveAttribute(
          "data-theme",
          item.theme,
        );
        const group = dialog.getByRole("group", {
          name: "Color theme",
          exact: true,
        });

        async function capture(state: string) {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          const bytes = await stableScreenshot(page);
          const observation = await observe(item.enabled ? group : dialog);
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

        if (!item.enabled) {
          await expect(group).toHaveCount(0);
          await expect(page.locator("html")).not.toHaveAttribute(
            "data-gradient-color-themes",
          );
          await page.mouse.move(0, 0);
          await capture("hidden");
        } else {
          await expect(group).toBeVisible();
          await expect(group.getByRole("button")).toHaveCount(8);
          await expect(
            group.getByRole("button", { name: "Blue horizon", exact: true }),
          ).toHaveAttribute("aria-pressed", "true");
          async function centerGroup() {
            await group.evaluate((element) =>
              element.scrollIntoView({ block: "center" }),
            );
            const box = await group.boundingBox();
            assert(
              box && box.y >= 0 && box.y + box.height <= item.viewport.height,
              "All eight swatches must be visible",
            );
          }
          await centerGroup();
          await page.mouse.move(0, 0);
          await capture("palette");
          const golden = group.getByRole("button", {
            name: "Golden hour",
            exact: true,
          });
          const citrus = group.getByRole("button", {
            name: "Citrus spark",
            exact: true,
          });
          await golden.hover();
          await capture("hover");
          await page.mouse.move(0, 0);
          await golden.focus();
          await page.keyboard.press("Tab");
          await expect(citrus).toBeFocused();
          await capture("keyboard-focus");
          await page.keyboard.press("Space");
          await expect(citrus).toHaveAttribute("aria-pressed", "true");
          await expect.poll(() => preferences.colorTheme).toBe("citrus-spark");
          await capture("keyboard-selected");
          for (const palette of caseFile.palettes) {
            const control = group.getByRole("button", {
              name: palette.label,
              exact: true,
            });
            await control.click();
            await expect(control).toHaveAttribute("aria-pressed", "true");
            await expect(page.locator("html")).toHaveAttribute(
              "data-color-theme",
              palette.value,
            );
            await expect.poll(() => preferences.colorTheme).toBe(palette.value);
            await centerGroup();
            await page.mouse.move(0, 0);
            // The previews resolve their own palette, independently of the selected root palette.
            const gradients = await group
              .locator("span[data-color-theme]")
              .evaluateAll((elements) =>
                elements.map(
                  (element) => getComputedStyle(element).backgroundImage,
                ),
              );
            assert.equal(
              new Set(gradients).size,
              8,
              "Every swatch must retain its distinct gradient",
            );
            assert(!gradients.includes("none"));
            await capture(`selected-${palette.value}`);
          }
          await page.reload({ waitUntil: "domcontentloaded" });
          await expect(
            group.getByRole("button", { name: "Limelight", exact: true }),
          ).toHaveAttribute("aria-pressed", "true");
          await expect(page.locator("html")).toHaveAttribute(
            "data-color-theme",
            "limelight",
          );
          await centerGroup();
          await page.mouse.move(0, 0);
          await capture("reloaded");
        }
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      } catch (error) {
        const failure = `${item.id}: ${error instanceof Error ? error.message : String(error)}`;
        manifest.failures.push(failure);
        console.error(failure);
        const failedPage = context.pages()[0];
        if (failedPage) {
          await failedPage.screenshot({
            path: path.join(out, `${item.id}-failure.png`),
            fullPage: true,
          });
          await writeFile(
            path.join(out, `${item.id}-failure.txt`),
            await failedPage.locator("body").innerText(),
            { flag: "wx" },
          );
        }
      } finally {
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
