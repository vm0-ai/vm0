import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  chromium,
  expect as playwrightExpect,
  type Page,
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
  fixtureSha256: string;
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
  options: Object.fromEntries(
    [
      "app-url",
      "api-url",
      "expected-build",
      "source-sha",
      "storage-state",
      "fixture",
      "out",
      "baseline",
      "executable-path",
    ].map((name) => [name, { type: "string" as const }]),
  ),
});
function required(name: string): string {
  const value = values[name];
  assert(typeof value === "string" && value, `Missing --${name}`);
  return value;
}
async function observe(page: Page) {
  return page
    .locator(
      '[data-slot="language-setting"], [data-slot="timezone-setting"], [data-slot="select-content"]',
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const properties = [
          "background-color",
          "background-image",
          "color",
          "border-top-color",
          "border-top-width",
          "border-top-style",
          "border-radius",
          "padding",
          "font-family",
          "font-size",
          "font-weight",
          "line-height",
          "opacity",
          "outline",
          "box-shadow",
          "cursor",
        ];
        return [
          element,
          ...element.querySelectorAll('[role="combobox"], [role="option"]'),
        ].map((control) => {
          const box = control.getBoundingClientRect();
          const style = getComputedStyle(control);
          return {
            slot: control.getAttribute("data-slot"),
            role: control.getAttribute("role"),
            text: control.textContent?.trim(),
            label: control.getAttribute("aria-label"),
            expanded: control.getAttribute("aria-expanded"),
            selected: control.getAttribute("aria-selected"),
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
      }),
    );
}
async function run() {
  const appOrigin = new URL(required("app-url")).origin;
  const apiOrigin = new URL(required("api-url")).origin;
  assert.notEqual(appOrigin, apiOrigin);
  const appBuildSha = required("expected-build");
  const sourceSha = required("source-sha");
  for (const sha of [appBuildSha, sourceSha])
    assert(/^[a-f0-9]{40}$/.test(sha));
  const caseBytes = await readFile(
    path.join(__dirname, "settings-select-cases.json"),
  );
  const fixtureBytes = await readFile(required("fixture"));
  const frozen: Record<string, unknown> = JSON.parse(fixtureBytes.toString());
  assert(
    frozen["/api/org"] &&
      frozen["/api/agents"] &&
      frozen["/api/onboarding/status"] &&
      frozen["/api/feature-switches"] &&
      frozen["/api/billing/status"],
  );
  const onboarding = frozen["/api/onboarding/status"] as {
    defaultAgentId: string;
  };
  const defaultAgent = frozen[`/api/agents/${onboarding.defaultAgentId}`] as {
    agentId: string;
  };
  const agents = frozen["/api/agents"] as { agentId: string }[];
  assert(defaultAgent, "Freeze the default Agent detail response");
  assert.equal(defaultAgent.agentId, onboarding.defaultAgentId);
  assert(agents.some((agent) => agent.agentId === onboarding.defaultAgentId));
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all(
        [
          __filename,
          path.join(__dirname, "images.ts"),
          path.join(__dirname, "capture.ts"),
          path.join(__dirname, "bootstrap.ts"),
          path.join(__dirname, "../lib/preview-bypass.ts"),
          path.join(__dirname, "../../pnpm-lock.yaml"),
        ].map((file) => readFile(file)),
      ),
    ),
  );
  const caseFile: { version: number; cases: VisualCase[] } = JSON.parse(
    caseBytes.toString(),
  );
  assert.equal(caseFile.version, 1);
  const baselinePath = values.baseline;
  const baseline: Manifest | undefined =
    typeof baselinePath === "string"
      ? JSON.parse(
          await readFile(path.join(baselinePath, "manifest.json"), "utf8"),
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
    assert.deepEqual(baseline.failures, []);
  }
  const out = path.resolve(required("out"));
  await mkdir(out);
  const browser = await chromium.launch({
    executablePath:
      typeof values["executable-path"] === "string"
        ? values["executable-path"]
        : undefined,
    args: browserArgs,
  });
  const manifest: Manifest = {
    version: 1,
    protocol: "channel-rounding-v1",
    caseSha256: sha256(caseBytes),
    fixtureSha256: sha256(fixtureBytes),
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
    if (baseline) assert.equal(baseline.browser, manifest.browser);
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
      let releaseSave: (() => void) | undefined;
      let savePending: Promise<void> | undefined;
      let saveArrived = false;
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
        const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
        if (secret)
          await context.route(
            (url) => url.origin === apiOrigin,
            async (route) =>
              route.continue({
                headers: {
                  ...route.request().headers(),
                  "x-vercel-protection-bypass": secret,
                },
              }),
          );
        const page = await context.newPage();
        page.setDefaultTimeout(30_000);
        page.on("response", (response) => {
          const url = new URL(response.url());
          if (url.origin === apiOrigin && response.status() >= 400)
            manifest.failures.push(
              `${item.id}: API HTTP ${response.status()} ${url.pathname}`,
            );
        });
        const preferences = {
          timezone: "Etc/UTC",
          locale: "en-US",
          translationLanguage: "en",
          supportedLocales: ["en-US", "ja-JP"],
          pinnedAgentIds: [],
          sendMode: "enter",
          cloudBrowserEnabledByDefault: true,
          theme: item.theme,
          colorTheme: "blue-horizon",
          captureNetworkBodiesRemaining: 0,
          voiceInputModel: null,
        };
        const fixtures = { ...frozen, "/api/user-preferences": preferences };
        await fixtureBootstrap(page, appOrigin, () => fixtures);
        for (const [pathname, body] of Object.entries(frozen)) {
          await page.route(
            (url) => url.origin === apiOrigin && url.pathname === pathname,
            async (route) => {
              assert.equal(
                route.request().method(),
                "GET",
                `Unexpected fixture mutation ${pathname}`,
              );
              await route.fulfill({ json: body });
            },
          );
        }
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
                if (
                  savePending &&
                  (update.timezone !== undefined || update.locale !== undefined)
                ) {
                  saveArrived = true;
                  await savePending;
                }
                for (const [key, value] of Object.entries(update)) {
                  if (key === "timezone") {
                    assert(value === "Etc/UTC" || value === "Asia/Tokyo");
                    preferences.timezone = value;
                  } else if (key === "locale") {
                    assert(value === "en-US" || value === "ja-JP");
                    preferences.locale = value;
                  } else
                    assert.deepEqual(
                      value,
                      Reflect.get(preferences, key),
                      `Unexpected preference ${key}`,
                    );
                }
              } else assert.equal(route.request().method(), "GET");
              await route.fulfill({ json: preferences });
            } catch (error) {
              manifest.failures.push(`${item.id}: ${String(error)}`);
              await route.fulfill({
                status: 500,
                body: "Rejected preference fixture mutation",
              });
            }
          },
        );
        async function ready() {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(page.locator("html")).toHaveAttribute(
            "lang",
            preferences.locale,
          );
          await expect(
            page.locator('[data-slot="language-setting"] [role="combobox"]'),
          ).toBeEnabled();
          await expect(
            page.locator('[data-slot="timezone-setting"] [role="combobox"]'),
          ).toBeEnabled();
          if (!item.isMobile)
            await expect(
              page.getByRole("button", {
                name: "Get Pro",
                exact: true,
                includeHidden: true,
              }),
            ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: item.theme === "light" ? "Light" : "Dark",
              exact: true,
            }),
          ).toHaveAttribute("aria-pressed", "true");
        }
        await page.goto(new URL(item.path, appOrigin).href, {
          waitUntil: "domcontentloaded",
        });
        await ready();
        const language = page.locator(
          '[data-slot="language-setting"] [role="combobox"]',
        );
        const timezone = page.locator(
          '[data-slot="timezone-setting"] [role="combobox"]',
        );
        async function activate(control: Locator) {
          if (item.hasTouch) await control.tap();
          else await control.click();
        }
        async function capture(state: string) {
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          const bytes = await stableScreenshot(page);
          const observation = await observe(page);
          await writeFile(path.join(out, image), bytes, { flag: "wx" });
          const record: Capture = {
            id,
            image,
            sha256: sha256(bytes),
            observation,
            status: "BASELINE",
          };
          if (baseline && typeof baselinePath === "string") {
            const reference = baseline.captures.find(
              (entry) => entry.id === id,
            );
            assert(reference, `Missing baseline ${id}`);
            const before = await readFile(
              path.join(baselinePath, reference.image),
            );
            assert.equal(sha256(before), reference.sha256);
            const result = compareImages(before, bytes);
            const equal =
              JSON.stringify(reference.observation) ===
              JSON.stringify(observation);
            Object.assign(record, {
              changedPixels: result.changedPixels,
              contentChangedPixels: result.contentChangedPixels,
              roundingPixels: result.roundingPixels,
              status:
                result.contentChangedPixels === 0 && equal ? "PASS" : "FAIL",
            });
            await writeFile(path.join(out, `${id}-before.png`), before, {
              flag: "wx",
            });
            await writeFile(path.join(out, `${id}-diff.png`), result.diff, {
              flag: "wx",
            });
            if (record.status === "FAIL")
              manifest.failures.push(
                `${id}: ${result.contentChangedPixels} content pixels; observationsEqual=${equal}`,
              );
          }
          manifest.captures.push(record);
          console.log(
            `${id}: ${record.status} (${record.changedPixels ?? 0} raw pixels)`,
          );
        }
        await language.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("language-idle");
        await language.hover();
        await capture("language-hover");
        await activate(language);
        await expect(page.getByRole("listbox")).toBeVisible();
        await capture("language-open");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("listbox")).not.toBeVisible();
        await page.mouse.move(0, 0);
        await language.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(language).toBeFocused();
        await capture("language-keyboard-focus");
        await activate(language);
        saveArrived = false;
        savePending = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        await activate(
          page.getByRole("option", { name: "日本語", exact: true }),
        );
        await expect(language).toBeDisabled();
        await expect(page.getByRole("listbox")).not.toBeVisible();
        await page.mouse.move(0, 0);
        await expect.poll(() => saveArrived).toBe(true);
        await expect(page.locator("html")).toHaveAttribute("lang", "ja-JP");
        await expect(language).toHaveText(/日本語/);
        await capture("language-saving");
        releaseSave?.();
        savePending = undefined;
        await expect(page.locator("html")).toHaveAttribute("lang", "ja-JP");
        await expect(language).toBeEnabled();
        await expect(language).toHaveText(/日本語/);
        await capture("language-saved");
        await activate(language);
        await page
          .getByRole("option", { name: "English", exact: true })
          .click();
        await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
        await expect(language).toBeEnabled();
        await timezone.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("timezone-idle");
        await timezone.hover();
        await capture("timezone-hover");
        await activate(timezone);
        await expect(page.getByRole("listbox")).toBeVisible();
        await capture("timezone-open");
        await page.keyboard.press("Escape");
        await expect(page.getByRole("listbox")).not.toBeVisible();
        await page.mouse.move(0, 0);
        await timezone.focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.getByRole("listbox")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(timezone).toBeFocused();
        await capture("timezone-keyboard-focus");
        await activate(timezone);
        saveArrived = false;
        savePending = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        await activate(page.getByRole("option", { name: /Tokyo/ }));
        await expect(timezone).toBeDisabled();
        await expect(page.getByRole("listbox")).not.toBeVisible();
        await page.mouse.move(0, 0);
        await expect.poll(() => saveArrived).toBe(true);
        await capture("timezone-saving");
        releaseSave?.();
        savePending = undefined;
        await expect(timezone).toBeEnabled();
        await expect(timezone).toHaveText(/Tokyo/);
        await capture("timezone-saved");
        await page.reload({ waitUntil: "domcontentloaded" });
        await ready();
        await expect(timezone).toHaveText(/Tokyo/);
        await timezone.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("timezone-reloaded");
      } catch (error) {
        manifest.failures.push(`${item.id}: ${String(error)}`);
        console.error(`${item.id}: ${String(error)}`);
        const page = context.pages()[0];
        if (page) {
          await page.screenshot({
            path: path.join(out, `${item.id}-failure.png`),
            fullPage: true,
          });
          await writeFile(
            path.join(out, `${item.id}-failure.txt`),
            await page.locator("body").innerText(),
            { flag: "wx" },
          );
        }
      } finally {
        releaseSave?.();
        await context.close();
      }
    }
    assert.equal(
      manifest.captures.length,
      caseFile.cases.length * 13,
      "Every case must contain all 13 states",
    );
    if (baseline)
      assert.equal(manifest.captures.length, baseline.captures.length);
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
  console.error(String(error));
  process.exitCode = 1;
});
