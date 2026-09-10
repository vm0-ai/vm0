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
import { installChatEmojiFixture, threadId } from "./chat-emoji-fixture";

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
  userAgent: string;
  captures: Capture[];
  cases: VisualCase[];
  fixtureSha256: string;
  apiBuildSha: string;
  featureSwitches: Record<string, boolean>;
  prerequisites: string;
  workerRequests: Record<string, string[]>;
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
    "api-build": { type: "string" },
    case: { type: "string" },
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
    return [
      ...element.querySelectorAll(
        "button, button > span, [data-testid=chat-thread-header-title], [data-chat-thread-emoji-feed] + div, [data-chat-thread-emoji-feed] + div > span",
      ),
    ].map((control) => {
      const box = control.getBoundingClientRect();
      const style = getComputedStyle(control);
      return {
        tag: control.tagName,
        text: control.textContent?.trim(),
        disabled: control.hasAttribute("disabled"),
        role: control.getAttribute("role"),
        label: control.getAttribute("aria-label"),
        hidden: control.getAttribute("aria-hidden"),
        type: control.getAttribute("type"),
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
  const caseBytes = await readFile(
    path.join(__dirname, "chat-emoji-cases.json"),
  );
  const runnerSha256 = sha256(
    Buffer.concat(
      await Promise.all([
        readFile(__filename),
        readFile(path.join(__dirname, "chat-emoji-fixture.ts")),
        readFile(path.join(__dirname, "chat-emoji-worker.ts")),
        readFile(path.join(__dirname, "images.ts")),
        readFile(path.join(__dirname, "capture.ts")),
        readFile(path.join(__dirname, "bootstrap.ts")),
        readFile(path.join(__dirname, "../lib/preview-bypass.ts")),
        readFile(path.join(__dirname, "../../pnpm-lock.yaml")),
      ]),
    ),
  );
  const apiBuildSha = required("api-build");
  assert(/^[a-f0-9]{40}$/.test(apiBuildSha));
  const fixtureBytes = await readFile(
    path.join(__dirname, "chat-emoji-fixture.ts"),
  );
  const caseFile: { version: number; cases: VisualCase[] } = JSON.parse(
    caseBytes.toString(),
  );
  assert.equal(caseFile.version, 1);
  if (values.case)
    caseFile.cases = caseFile.cases.filter((item) => item.id === values.case);
  assert(caseFile.cases.length > 0);
  const baseline: Manifest | undefined = values.baseline
    ? JSON.parse(
        await readFile(path.join(values.baseline, "manifest.json"), "utf8"),
      )
    : undefined;
  if (baseline) {
    assert.equal(baseline.protocol, "channel-rounding-v1");
    assert.deepEqual(baseline.cases, caseFile.cases);
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
  const server = await chromium.launchServer({
    executablePath: values["executable-path"],
    args: [
      ...browserArgs,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
    ],
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const chromiumProfile = server
    .process()
    .spawnargs.find((argument) => argument.startsWith("--user-data-dir="))
    ?.slice("--user-data-dir=".length);
  assert(chromiumProfile, "Use the profile belonging to the launched browser");
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
    userAgent: "",
    captures: [],
    cases: caseFile.cases,
    apiBuildSha,
    featureSwitches: {
      chatThreadHeaderActions: true,
      _realAgentInPreview: false,
    },
    prerequisites:
      "Isolated Clerk TEST account; onboarding, empty threads and API metadata controlled before HTML bootstrap and fetch. No runs, connectors or purchases.",
    fixtureSha256: sha256(fixtureBytes),
    workerRequests: {},
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

      let worker:
        | Awaited<ReturnType<typeof installChatEmojiFixture>>
        | undefined;
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
        page.setDefaultTimeout(30_000);
        manifest.userAgent = await page.evaluate(() => navigator.userAgent);
        if (baseline) assert.equal(manifest.userAgent, baseline.userAgent);
        worker = await installChatEmojiFixture(
          page,
          appOrigin,
          apiOrigin,
          item.theme,
          manifest.failures,
          chromiumProfile,
        );
        await page.goto(
          new URL(item.path.replace(":threadId", threadId), appOrigin).href,
          { waitUntil: "domcontentloaded" },
        );
        const changeIcon = page.getByRole("button", {
          name: "Change icon",
          exact: true,
        });
        await expect(changeIcon).toBeVisible();
        await expect(changeIcon).toHaveText("😀");
        await expect(page.locator("html")).toHaveClass(
          item.theme === "dark"
            ? /(?:^| )dark(?: |$)/
            : /^(?!.*(?:^| )dark(?: |$)).*$/,
        );
        const search = page.getByRole("textbox", {
          name: "Search emoji",
          exact: true,
        });
        const feed = page.locator("[data-chat-thread-emoji-feed]");
        const group = page.locator("body");
        async function capture(state: string) {
          await expect(
            page.locator('meta[name="okou-app-git-commit-sha"]'),
          ).toHaveAttribute("content", appBuildSha);
          const id = `${item.id}-${state}`;
          const image = `${id}.png`;
          await expect(page.locator("#app-bootstrap-skeleton")).toBeHidden();
          await expect(changeIcon).toBeVisible();
          if (!item.isMobile)
            await expect(
              page.getByText("More credits & concurrent runs", { exact: true }),
            ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Voice input", exact: true }),
          ).toBeEnabled();
          await expect(
            page.getByRole("button", { name: "Send", exact: true }),
          ).toBeDisabled();
          if (!(await search.isVisible())) {
            // The composer autofocuses after reload. Move focus to the real
            // chat region so its blinking caret is outside this icon scenario.
            const chatRegion = page.getByRole("region", {
              name: "Chat thread",
              exact: true,
            });
            await chatRegion.focus();
            await expect(chatRegion).toBeFocused();
            assert(
              await changeIcon.evaluate((element) => {
                const box = element.getBoundingClientRect();
                return element.contains(
                  document.elementFromPoint(
                    box.x + box.width / 2,
                    box.y + box.height / 2,
                  ),
                );
              }),
              "Chat icon is obscured",
            );
          }
          const bytes = await stableScreenshot(page);
          const observation = await observe(group);
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

        await page.mouse.move(0, 0);
        await capture("color-header");
        await changeIcon.click();
        await expect(search).toBeVisible();
        await search.fill("grinning face");
        const color = feed.getByRole("button", {
          name: "grinning face",
          exact: true,
        });
        await color.hover();
        await color.focus();
        await expect(
          page.getByText(":grinning_face:", { exact: true }),
        ).toBeVisible();
        await capture("color-preview-hover");
        await search.fill("reserved");
        const dual = feed.getByRole("button", {
          name: "Japanese “reserved” button",
          exact: true,
        });
        await page.mouse.move(0, 0);
        await search.press("Tab");
        await page.keyboard.press("Tab");
        await expect(dual).toBeFocused();
        await expect(
          page.locator('span[aria-hidden="true"]').filter({ hasText: "🈯" }),
        ).toHaveCount(2);
        await capture("dual-presentation-keyboard");
        await page.keyboard.press("Space");
        await expect(search).not.toBeVisible();
        await expect(changeIcon).toHaveText("🈯");
        await capture("dual-presentation-selected");
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(changeIcon).toHaveText("🈯");
        await page.mouse.move(0, 0);
        await capture("reloaded");
        await changeIcon.click();
        await expect(search).toBeVisible();
        await page.getByRole("button", { name: "Remove", exact: true }).click();
        await expect(search).not.toBeVisible();
        await expect(changeIcon).toHaveText("");
        await expect(page.getByTestId("chat-thread-header-title")).toHaveText(
          "Emoji planning ABC 中文",
        );
        await capture("text-fallback");
        await changeIcon.click();
        await expect(search).toBeVisible();
        await search.fill("no-such-chat-emoji");
        await expect(
          page.getByText("No emoji found", { exact: true }),
        ).toBeVisible();
        await page.mouse.move(0, 0);
        await search.press("Tab");
        await capture("empty-search");
        await page.keyboard.press("Escape");
        await expect(search).not.toBeVisible();
        await expect(
          page.getByRole("region", { name: "Chat thread", exact: true }),
        ).toBeFocused();
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
        manifest.workerRequests[item.id] = [...(worker?.paths ?? [])].sort();
        if (!worker?.paths.has("GET /api/chat-threads/snapshot"))
          manifest.failures.push(
            `${item.id}: SharedWorker snapshot fixture was not exercised`,
          );
        await worker?.close();
        await context.close();
      }
    }
    assert.equal(
      manifest.captures.length,
      caseFile.cases.length * 7,
      "Every configured state must be captured",
    );
    if (baseline)
      assert.equal(
        manifest.captures.length,
        baseline.captures.length,
        "Not every frozen case was replayed",
      );
  } finally {
    await writeFile(
      path.join(out, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await browser.close();
    await server.close();
  }
  assert.equal(manifest.failures.length, 0, manifest.failures.join("\n"));
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
