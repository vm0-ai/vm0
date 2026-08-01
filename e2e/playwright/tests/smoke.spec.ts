import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { expect, test } from "../fixtures";
import {
  refreshClerkSessionToken,
  signInWithClerkTestingHelper,
} from "../lib/auth";
import {
  authHeadersForToken,
  completeExploreOnboarding,
} from "../lib/onboarding";
import { deriveAppUrl, STORAGE_STATE } from "../playwright.config";

test("complete app onboarding to chat page", async ({ browser, page }) => {
  test.setTimeout(240_000);

  const email = process.env.E2E_CLERK_USER_EMAIL!;
  const orgId = process.env.E2E_CLERK_ORG_ID!;
  const apiUrl = process.env.VM0_API_BACKEND_URL!;
  const appUrl = deriveAppUrl(apiUrl);

  await signInWithClerkTestingHelper(page, email, appUrl, {
    activeOrganizationId: orgId,
  });

  await completeExploreOnboarding(page, {
    appUrl,
  });

  // Verify: landed on chat page
  await page.waitForURL("**/agents/*/chat", {
    timeout: 120_000,
    waitUntil: "domcontentloaded",
  });
  expect(page.url()).toMatch(/\/agents\/.*\/chat/);

  await refreshClerkSessionToken(page, { activeOrganizationId: orgId });

  const token = await page.evaluate(async () => {
    return (await window.Clerk?.session?.getToken({ skipCache: true })) ?? null;
  });
  if (!token) {
    throw new Error("Clerk session token unavailable for Playwright setup");
  }

  // Pin reused Playwright identities to the mock runtime before feature tests.
  const featureSwitchResponse = await page.request.post(
    new URL("/api/zero/feature-switches", apiUrl).toString(),
    {
      headers: authHeadersForToken(token),
      data: {
        switches: { realAgentInPreview: false },
      },
    },
  );
  expect(featureSwitchResponse.status()).toBe(200);

  const runnerGroup = process.env.E2E_RUNNER_GROUP;
  if (runnerGroup) {
    const response = await page.request.post(
      new URL("/api/test/agent-composes", apiUrl).toString(),
      {
        headers: authHeadersForToken(token),
        data: {
          content: {
            version: "1",
            agents: {
              "default-agent": {
                framework: "claude-code",
                instructions: "CLAUDE.md",
                environment: {
                  ZERO_AGENT_ID: "${{ vars.ZERO_AGENT_ID }}",
                  ZERO_TOKEN: "${{ secrets.ZERO_TOKEN }}",
                },
                experimental_runner: { group: runnerGroup },
              },
            },
          },
        },
      },
    );
    expect(response.status()).toBe(200);
  }

  // Save storageState for feature tests (use absolute path to match playwright.config.ts)
  await page.context().storageState({ path: STORAGE_STATE });

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const verificationContext = await browser.newContext({
    storageState: STORAGE_STATE,
    extraHTTPHeaders: bypassSecret
      ? { "x-vercel-protection-bypass": bypassSecret }
      : undefined,
    ignoreHTTPSErrors: true,
  });
  try {
    await setupClerkTestingToken({ context: verificationContext });
    const verificationPage = await verificationContext.newPage();
    await verificationPage.goto(`${appUrl}/agents`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      verificationPage.getByRole("heading", { name: "Agents" }),
    ).toBeVisible({ timeout: 20_000 });
    await verificationPage.waitForFunction(
      (organizationId) => window.Clerk?.organization?.id === organizationId,
      orgId,
      { timeout: 30_000 },
    );
  } finally {
    await verificationContext.close();
  }
});

test("keep scrollbar thumbs visible without global hover styling", async ({
  page,
}) => {
  const apiUrl = process.env.VM0_API_BACKEND_URL!;
  const appUrl = deriveAppUrl(apiUrl);

  await page.goto(`${appUrl}/_/error`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    return (
      getComputedStyle(document.documentElement).getPropertyValue(
        "scrollbar-color",
      ) !== "auto"
    );
  });
  await page.locator("#app-bootstrap-skeleton").waitFor({ state: "detached" });

  // Paint invalidation is not exposed as a DOM observable. This probe verifies
  // the production stylesheet's visible scrollbar cascade in real Chromium.
  await page.mouse.move(0, 0);
  const scrollbar = page.locator("[data-scrollbar-repaint-probe]");
  await page.evaluate(() => {
    const element = document.createElement("div");
    element.dataset.scrollbarRepaintProbe = "";
    Object.assign(element.style, {
      position: "fixed",
      top: "200px",
      left: "200px",
      width: "80px",
      height: "80px",
      overflow: "scroll",
      zIndex: "2147483647",
    });

    const contents = document.createElement("div");
    contents.style.width = "160px";
    contents.style.height = "160px";
    element.append(contents);
    document.body.append(element);
  });

  const { idleColor, transparentColor } = await scrollbar.evaluate(
    (element) => {
      const idleColor =
        getComputedStyle(element).getPropertyValue("scrollbar-color");
      const transparentProbe = document.createElement("div");
      transparentProbe.style.setProperty(
        "scrollbar-color",
        "transparent transparent",
        "important",
      );
      document.body.append(transparentProbe);
      const transparentColor =
        getComputedStyle(transparentProbe).getPropertyValue("scrollbar-color");
      transparentProbe.remove();
      return { idleColor, transparentColor };
    },
  );

  expect(idleColor).not.toBe(transparentColor);

  const globalHoverScrollbarRules = await page.evaluate(() => {
    const matches: string[] = [];

    function visit(rules: CSSRuleList): void {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          const hasGlobalHover = rule.selectorText
            .split(",")
            .some((selector) => {
              const normalized = selector.trim();
              return (
                normalized === ":hover" ||
                normalized === "*:hover" ||
                normalized.startsWith(":hover::") ||
                normalized.startsWith("*:hover::")
              );
            });
          const changesScrollbar =
            rule.style.getPropertyValue("scrollbar-color") !== "" ||
            rule.selectorText.includes("::-webkit-scrollbar");
          if (hasGlobalHover && changesScrollbar) {
            matches.push(rule.cssText);
          }
          continue;
        }
        if (rule instanceof CSSGroupingRule) {
          visit(rule.cssRules);
        }
      }
    }

    for (const styleSheet of document.styleSheets) {
      if (
        styleSheet.href !== null &&
        new URL(styleSheet.href).origin !== location.origin
      ) {
        continue;
      }
      visit(styleSheet.cssRules);
    }

    return matches;
  });

  expect(globalHoverScrollbarRules).toEqual([]);

  await scrollbar.hover();

  await expect
    .poll(async () => {
      return scrollbar.evaluate((element) => {
        return getComputedStyle(element).getPropertyValue("scrollbar-color");
      });
    })
    .toBe(idleColor);
});
