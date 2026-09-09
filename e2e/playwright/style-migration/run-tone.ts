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
  pressed: (string | null)[];
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
  ariaMode: "legacy" | "pressed";
  fixtureSha256: string;
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
    "agent-fixture": { type: "string" },
    "aria-mode": { type: "string" },
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

async function observe(group: Locator) {
  return group.evaluate((element) => {
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
      "display",
      "align-items",
      "justify-content",
      "text-align",
      "min-width",
      "opacity",
      "outline",
      "outline-offset",
      "overflow",
    ];
    return Array.from(element.querySelectorAll("button")).map((control) => {
      const box = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return {
        tag: control.tagName,
        text: control.textContent?.trim(),
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
  const caseBytes = await readFile(path.join(__dirname, "tone-cases.json"));
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
  const ariaMode = required("aria-mode");
  assert(ariaMode === "legacy" || ariaMode === "pressed");
  const fixtureBytes = await readFile(required("agent-fixture"));
  const fixture: { agentId: string; sound: string; [key: string]: unknown } =
    JSON.parse(fixtureBytes.toString());
  assert(/^[a-f0-9-]{36}$/.test(fixture.agentId));
  assert.equal(
    fixture.sound,
    "professional",
    "Use a synthetic professional-tone fixture",
  );
  const caseFile: {
    version: number;
    cases: VisualCase[];
    tones: {
      value: string;
      label: string;
      hint: string;
      agentSample: string;
      userSample: string;
    }[];
  } = JSON.parse(caseBytes.toString());
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
    assert.equal(
      baseline.fixtureSha256,
      sha256(fixtureBytes),
      "Frozen agent fixture changed",
    );
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
    ariaMode,
    fixtureSha256: sha256(fixtureBytes),
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
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            url.pathname === "/api/user-preferences",
          async (route) => {
            // Theme bootstrap can sync the already-selected values. Tone never changes preferences.
            if (route.request().method() === "POST") {
              const update: Record<string, unknown> = route
                .request()
                .postDataJSON();
              for (const [key, value] of Object.entries(update)) {
                assert.deepEqual(
                  value,
                  Reflect.get(preferences, key),
                  `Unexpected preference update: ${key}`,
                );
              }
            } else assert.equal(route.request().method(), "GET");
            await route.fulfill({ json: preferences });
          },
        );
        let profile = { ...fixture };
        const onboarding = () => ({
          needsOnboarding: false,
          onboardingComplete: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: true,
          defaultAgentId: fixture.agentId,
          defaultAgentMetadata: {
            displayName: profile.displayName,
            sound: profile.sound,
            avatarUrl: profile.avatarUrl,
          },
        });
        // Preview redeploys recreate the real default Agent with a new ID.
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            url.pathname === "/api/onboarding/status",
          async (route) => {
            assert.equal(route.request().method(), "GET");
            await route.fulfill({ json: onboarding() });
          },
        );
        await fixtureBootstrap(page, appOrigin, () => ({
          "/api/user-preferences": preferences,
          "/api/onboarding/status": onboarding(),
          "/api/agents": [profile],
        }));
        let savePending: Promise<void> | undefined;
        await page.route(
          (url) =>
            url.origin === apiOrigin &&
            (url.pathname === "/api/agents" ||
              url.pathname === `/api/agents/${fixture.agentId}`),
          async (route) => {
            try {
              const request = route.request();
              if (request.method() === "PATCH") {
                assert.equal(
                  new URL(request.url()).pathname,
                  `/api/agents/${fixture.agentId}`,
                );
                const update: Record<string, unknown> = request.postDataJSON();
                assert(
                  caseFile.tones.some((tone) => tone.value === update.sound),
                );
                for (const [key, value] of Object.entries(update)) {
                  if (key !== "sound")
                    assert.deepEqual(
                      value,
                      Reflect.get(fixture, key),
                      `Unexpected metadata change: ${key}`,
                    );
                }
                if (savePending) await savePending;
                profile = { ...profile, ...update };
              } else assert.equal(request.method(), "GET");
              await route.fulfill({
                json:
                  new URL(request.url()).pathname === "/api/agents"
                    ? [profile]
                    : profile,
              });
            } catch (error) {
              manifest.failures.push(
                `${item.id}: agent fixture: ${String(error)}`,
              );
              await route.fulfill({
                status: 500,
                body: "Agent fixture rejected the request",
              });
            }
          },
        );
        await page.goto(
          new URL(item.path.replace(":agentId", fixture.agentId), appOrigin)
            .href,
          {
            waitUntil: "domcontentloaded",
          },
        );
        await expect(
          page.locator('meta[name="okou-app-git-commit-sha"]'),
        ).toHaveAttribute("content", appBuildSha);
        const group = page.getByRole("group", { name: "Tone", exact: true });
        await expect(group).toBeVisible();
        const section = page.getByRole("group", {
          name: `How ${fixture.displayName} sounds`,
          exact: true,
        });
        await expect(page.locator("html")).toHaveClass(
          item.theme === "dark"
            ? /(?:^| )dark(?: |$)/
            : /^(?!.*(?:^| )dark(?: |$)).*$/,
        );
        const buttons = caseFile.tones.map((tone) =>
          group.getByRole("button", { name: tone.label, exact: true }),
        );
        const save = page.getByRole("button", {
          name: "Save",
          exact: true,
        });
        const discard = page.getByRole("button", {
          name: "Discard",
          exact: true,
        });
        let selected = 0;
        async function expectTone(index: number) {
          selected = index;
          await expect(group.getByRole("button")).toHaveCount(4);
          await expect(
            page.getByText(caseFile.tones[index].userSample, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(caseFile.tones[index].hint, { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText(caseFile.tones[index].agentSample, { exact: true }),
          ).toBeVisible();
          for (let button = 0; button < buttons.length; button++) {
            if (ariaMode === "pressed")
              await expect(buttons[button]).toHaveAttribute(
                "aria-pressed",
                String(button === index),
              );
            else
              assert.equal(
                await buttons[button].getAttribute("aria-pressed"),
                null,
              );
          }
        }
        await expectTone(0);

        async function capture(state: string) {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          // Keep the complete sample visible above the narrow viewport's save bar.
          if (item.isMobile) {
            await section.evaluate((element) =>
              element.scrollIntoView({
                block: "center",
                inline: "nearest",
                behavior: "instant",
              }),
            );
            const sample = page.getByText(
              caseFile.tones[selected].agentSample,
              { exact: true },
            );
            await expect(sample).toBeInViewport({ ratio: 1 });
            await expect(buttons[0]).toBeInViewport({ ratio: 1 });
            if (await discard.isVisible()) {
              const sampleBox = await sample.boundingBox();
              const barBox = await page
                .getByTestId("unsaved-bar")
                .boundingBox();
              assert(
                sampleBox &&
                  barBox &&
                  sampleBox.y + sampleBox.height <= barBox.y,
                "Save bar obscures the tone sample",
              );
            }
          }
          const bytes = await stableScreenshot(page);
          await expectTone(selected);
          const observation = await observe(group);
          const pressed = await Promise.all(
            buttons.map((button) => button.getAttribute("aria-pressed")),
          );
          await writeFile(path.join(out, image), bytes, { flag: "wx" });
          const record: Capture = {
            id,
            image,
            sha256: sha256(bytes),
            observation,
            pressed,
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

        await group.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("professional");
        await buttons[0].hover();
        await capture("selected-hover");
        await buttons[1].hover();
        await capture("inactive-hover");
        await page.mouse.move(0, 0);
        await buttons[0].focus();
        await page.keyboard.press("Tab");
        await expect(buttons[1]).toBeFocused();
        await capture("keyboard-focus");
        await page.keyboard.press("Space");
        await expectTone(1);
        await expect(save).toBeVisible();
        await capture("friendly");
        for (const index of [2, 3]) {
          await buttons[index].click();
          await expectTone(index);
          await page.mouse.move(0, 0);
          await capture(caseFile.tones[index].value);
        }
        await discard.click();
        await expectTone(0);
        await expect(save).not.toBeVisible();
        await group.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await capture("discarded");
        await buttons[1].click();
        await expectTone(1);
        savePending = new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        await save.click();
        await expect(discard).toBeDisabled();
        await page.mouse.move(0, 0);
        await capture("saving");
        releaseSave?.();
        savePending = undefined;
        await expect(
          page.getByText("Profile saved", { exact: true }),
        ).toBeVisible();
        await expect(save).not.toBeVisible();
        await expect(
          page.getByText("Profile saved", { exact: true }),
        ).not.toBeVisible();
        await group.scrollIntoViewIfNeeded();
        await capture("saved");
        await page.reload({ waitUntil: "domcontentloaded" });
        await expectTone(1);
        await expect(save).not.toBeVisible();
        await group.scrollIntoViewIfNeeded();
        await capture("reloaded");
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
