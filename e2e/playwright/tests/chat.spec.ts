import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import { omitAppApiPrefetch } from "../lib/app-api-prefetch";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(resolveApiBackendUrl());
const MOBILE_VIEWPORT = { width: 402, height: 874 } as const;
const MOBILE_SAFE_BOTTOM_PX = 34;
const HOME_BOTTOM_GAP_PX = 48;
const CONNECTORS_BOTTOM_GAP_PX = 64;

test("chat page displays tagline after onboarding", async ({ page }) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  await expect(page.getByTestId("chat-tagline")).toBeVisible({
    timeout: 20_000,
  });
});

test("sidebar scrollbar meets the workspace edge without a mobile inset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 520 });
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const chatList = page.getByTestId("chat-list-column");
  const scrollViewport = page.getByRole("region", { name: "Chat threads" });
  const scrollbar = chatList.getByTestId("sidebar-scrollbar");
  const workspace = page.getByTestId("workspace-inset");
  await expect(chatList).toBeVisible({ timeout: 20_000 });
  await expect(scrollViewport).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toBeVisible({ timeout: 20_000 });

  // Populate the list through the product instead of trying to make the empty
  // state overflow by shrinking the viewport while the sidebar is loading.
  const newChatButton = chatList
    .getByRole("button", { name: "New chat", exact: true })
    .last();
  for (let index = 0; index < 20; index++) {
    const [response] = await Promise.all([
      page.waitForResponse((response) => {
        return (
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/chat-threads"
        );
      }),
      newChatButton.click(),
    ]);
    expect(response.status()).toBe(201);
    const thread: unknown = await response.json();
    if (
      typeof thread !== "object" ||
      thread === null ||
      !("id" in thread) ||
      typeof thread.id !== "string"
    ) {
      throw new Error("Expected the created chat thread to have an id");
    }
    await expect(page).toHaveURL(new URL(`/chats/${thread.id}`, appUrl).href);
    await expect(
      scrollViewport.locator(`a[href="/chats/${thread.id}"]`),
    ).toBeVisible();
  }

  await expect
    .poll(async () => {
      return scrollViewport.evaluate((element) => {
        return (
          element.clientHeight > 0 &&
          element.scrollHeight > element.clientHeight
        );
      });
    })
    .toBe(true);
  await expect(scrollbar).toBeVisible();

  const [chatListBox, scrollbarBox, workspaceBox] = await Promise.all([
    chatList.boundingBox(),
    scrollbar.boundingBox(),
    workspace.boundingBox(),
  ]);
  if (!chatListBox || !scrollbarBox || !workspaceBox) {
    throw new Error("Expected visible desktop sidebar geometry");
  }
  const desktopWorkspace = await workspace.evaluate((element) => {
    const style = getComputedStyle(element);
    const backgroundStyle = getComputedStyle(element, "::before");
    return {
      borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
      marginBottom: Number.parseFloat(style.marginBottom),
      marginLeft: Number.parseFloat(style.marginLeft),
      marginRight: Number.parseFloat(style.marginRight),
      marginTop: Number.parseFloat(style.marginTop),
      paddingLeft: Number.parseFloat(style.paddingLeft),
      backgroundLeft: Number.parseFloat(backgroundStyle.left),
    };
  });
  const chatListRight = chatListBox.x + chatListBox.width;
  const scrollbarRight = scrollbarBox.x + scrollbarBox.width;
  const workspaceSurfaceLeft = workspaceBox.x + desktopWorkspace.paddingLeft;
  expect(workspaceSurfaceLeft).toBeCloseTo(chatListRight, 0);
  expect(workspaceBox.x - scrollbarRight).toBeGreaterThanOrEqual(0);
  expect(workspaceBox.x - scrollbarRight).toBeLessThanOrEqual(2);
  expect(desktopWorkspace).toMatchObject({
    backgroundLeft: 0,
    marginBottom: 8,
    marginLeft: 0,
    marginRight: 8,
    marginTop: 8,
    paddingLeft: 0,
  });
  expect(desktopWorkspace.borderLeftWidth).toBeGreaterThan(0);

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(chatList).toBeHidden();
  const mobileWorkspace = await workspace.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderLeftWidth: Number.parseFloat(style.borderLeftWidth),
      bottom: rect.bottom,
      left: rect.left,
      marginBottom: Number.parseFloat(style.marginBottom),
      marginLeft: Number.parseFloat(style.marginLeft),
      marginRight: Number.parseFloat(style.marginRight),
      marginTop: Number.parseFloat(style.marginTop),
      right: rect.right,
      top: rect.top,
    };
  });
  expect(mobileWorkspace).toEqual({
    borderLeftWidth: 0,
    bottom: MOBILE_VIEWPORT.height,
    left: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    right: MOBILE_VIEWPORT.width,
    top: 0,
  });
});

test.describe("dark theme", () => {
  test.use({ colorScheme: "dark" });

  test("focused composer does not cast a dark veil", async ({ page }) => {
    await omitAppApiPrefetch(page, appUrl);

    await page.route("**/api/user-preferences", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }

      const response = await route.fetch();
      const preferences: unknown = await response.json();
      if (
        typeof preferences !== "object" ||
        preferences === null ||
        Array.isArray(preferences)
      ) {
        throw new Error("Expected user preferences to be an object");
      }
      await route.fulfill({
        response,
        json: { ...preferences, theme: "system" },
      });
    });

    await page.goto(appUrl);
    await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const composer = page.locator(".okou-composer");
    const editor = composer.getByRole("textbox", { name: "Message" });
    await editor.focus();
    await expect(editor).toBeFocused();
    await expect
      .poll(async () => {
        return composer.evaluate((element) => {
          return getComputedStyle(element, "::after").boxShadow;
        });
      })
      .toBe("none");
  });
});

test("mobile pages assign the bottom safe area to content and controls", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });
  const agentId = /\/agents\/([^/]+)\/chat/.exec(
    new URL(page.url()).pathname,
  )?.[1];
  if (!agentId) {
    throw new Error("Expected the home route to resolve an agent id");
  }

  // Give this test its own overflowing history instead of depending on chats
  // left by other tests sharing the account. Create through the desktop UI so
  // the mobile drawer does not need to be reopened after every navigation.
  const newChatButton = page
    .getByTestId("chat-list-column")
    .getByRole("button", { name: "New chat", exact: true })
    .last();
  for (let index = 0; index < 20; index++) {
    const [response] = await Promise.all([
      page.waitForResponse((response) => {
        return (
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/chat-threads"
        );
      }),
      newChatButton.click(),
    ]);
    expect(response.status()).toBe(201);
    const thread: unknown = await response.json();
    if (
      typeof thread !== "object" ||
      thread === null ||
      !("id" in thread) ||
      typeof thread.id !== "string"
    ) {
      throw new Error("Expected the created chat thread to have an id");
    }
    await expect(page).toHaveURL(new URL(`/chats/${thread.id}`, appUrl).href);
  }

  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(appUrl);
  const tagline = page.getByTestId("chat-tagline");
  await expect(tagline).toBeVisible({ timeout: 20_000 });

  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);

  const scrollViewport = page.locator("main").filter({ has: tagline });
  const scrollContent = page.getByTestId("agent-chat-scroll-content");
  const viewportBox = await scrollViewport.boundingBox();
  if (!viewportBox) {
    throw new Error("Expected visible chat safe-area geometry");
  }
  expect(viewportBox.y + viewportBox.height).toBeCloseTo(
    MOBILE_VIEWPORT.height,
    0,
  );
  await expect
    .poll(async () => {
      return scrollContent.evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).paddingBottom);
      });
    })
    .toBe(Math.max(HOME_BOTTOM_GAP_PX, MOBILE_SAFE_BOTTOM_PX));

  await page.evaluate(() => {
    document.documentElement.dataset.keyboardOpen = "true";
  });
  await page.getByRole("button", { name: "Open menu" }).click();

  const drawer = page.getByRole("complementary", { name: "Sidebar" });
  await expect(drawer).toBeVisible();
  const drawerScrollViewport = drawer.getByRole("region", {
    name: "Chat threads",
  });
  await expect
    .poll(async () => {
      return drawerScrollViewport.evaluate((element) => {
        return (
          element.clientHeight > 0 &&
          element.scrollHeight > element.clientHeight
        );
      });
    })
    .toBe(true);

  const drawerMetrics = await drawer.evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("Expected the mobile drawer to be an element");
    }
    const rect = element.getBoundingClientRect();
    const chatViewport = element.querySelector(
      '[data-testid="sidebar-scroll-area"]',
    );
    if (!(chatViewport instanceof HTMLElement)) {
      throw new Error("Expected the drawer's chat scroll viewport");
    }
    const controlBottoms = Array.from(
      element.querySelectorAll<HTMLElement>("a, button"),
    )
      // Virtualized rows outside the scrollport still have nonzero bounds.
      // Check their clipping viewport, and measure fixed controls separately.
      .filter((control) => {
        return !chatViewport.contains(control);
      })
      .map((control) => {
        return control.getBoundingClientRect();
      })
      .filter((controlRect) => {
        return controlRect.width > 0 && controlRect.height > 0;
      })
      .map((controlRect) => {
        return controlRect.bottom;
      });
    if (controlBottoms.length === 0) {
      throw new Error("Expected visible controls in the mobile drawer");
    }
    return {
      bottom: rect.bottom,
      paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
      lastControlBottom: Math.max(...controlBottoms),
      chatViewportBottom: chatViewport.getBoundingClientRect().bottom,
      chatViewportOverflowY: getComputedStyle(chatViewport).overflowY,
    };
  });

  expect(drawerMetrics.bottom).toBeCloseTo(MOBILE_VIEWPORT.height, 0);
  expect(drawerMetrics.paddingBottom).toBe(MOBILE_SAFE_BOTTOM_PX);
  expect(drawerMetrics.lastControlBottom).toBeLessThanOrEqual(
    MOBILE_VIEWPORT.height - MOBILE_SAFE_BOTTOM_PX,
  );
  expect(drawerMetrics.chatViewportBottom).toBeLessThanOrEqual(
    MOBILE_VIEWPORT.height - MOBILE_SAFE_BOTTOM_PX,
  );
  expect(drawerMetrics.chatViewportOverflowY).toMatch(/^(auto|scroll)$/);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.goto(new URL("/connectors", appUrl).href);
  const connectorsViewport = page.getByTestId("connectors-scroll-viewport");
  const connectorsContent = page.getByTestId("connectors-scroll-content");
  await expect(connectorsViewport).toBeVisible({ timeout: 20_000 });
  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);

  const connectorsViewportBox = await connectorsViewport.boundingBox();
  if (!connectorsViewportBox) {
    throw new Error("Expected visible connector safe-area geometry");
  }
  expect(connectorsViewportBox.y + connectorsViewportBox.height).toBeCloseTo(
    MOBILE_VIEWPORT.height,
    0,
  );
  await expect
    .poll(async () => {
      return connectorsContent.evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).paddingBottom);
      });
    })
    .toBe(Math.max(CONNECTORS_BOTTOM_GAP_PX, MOBILE_SAFE_BOTTOM_PX));

  await page.goto(new URL(`/agents/${agentId}`, appUrl).href);
  const detailSectionPicker = page.getByRole("combobox");
  await expect(detailSectionPicker).toBeVisible({ timeout: 20_000 });
  await detailSectionPicker.click();
  await page.getByRole("option", { name: "Instructions" }).click();
  const instructionsEditor = page.locator(
    '[contenteditable="true"][aria-label="Instructions editor"]',
  );
  await expect(instructionsEditor).toBeVisible();
  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);
  await instructionsEditor.press("End");
  await instructionsEditor.press("x");
  const unsavedBar = page.getByTestId("unsaved-bar");
  await expect(unsavedBar).toBeVisible();
  const unsavedBarBox = await unsavedBar.boundingBox();
  if (!unsavedBarBox) {
    throw new Error("Expected visible unsaved bar safe-area geometry");
  }
  expect(unsavedBarBox.y + unsavedBarBox.height).toBeLessThanOrEqual(
    MOBILE_VIEWPORT.height - MOBILE_SAFE_BOTTOM_PX,
  );
  await unsavedBar.getByTestId("discard-button").click();

  await page.goto(
    new URL("/browsers/00000000-0000-4000-a000-000000000000", appUrl).href,
  );
  const browserSessionPage = page.getByTestId("browser-session-page");
  await expect(browserSessionPage).toBeVisible({ timeout: 20_000 });
  await page.evaluate((safeBottom) => {
    document.documentElement.style.setProperty("--sab", `${safeBottom}px`);
  }, MOBILE_SAFE_BOTTOM_PX);
  const browserSessionPageBox = await browserSessionPage.boundingBox();
  if (!browserSessionPageBox) {
    throw new Error("Expected visible browser session safe-area geometry");
  }
  expect(browserSessionPageBox.y + browserSessionPageBox.height).toBeCloseTo(
    MOBILE_VIEWPORT.height,
    0,
  );
  await expect
    .poll(async () => {
      return browserSessionPage.evaluate((element) => {
        return Number.parseFloat(getComputedStyle(element).paddingBottom);
      });
    })
    .toBe(MOBILE_SAFE_BOTTOM_PX);
});

test("send a message through the deployed runner", async ({ page }) => {
  test.setTimeout(120_000);
  const marker = `PRODUCT_CHAT_E2E_${Date.now()}`;

  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  const composer = page.locator(".okou-composer");
  const editor = composer.getByRole("textbox", { name: "Message" });
  await expect(editor).toBeVisible();
  await editor.fill(`printf ${marker}`);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(
    page.locator('[data-role="assistant"]').filter({ hasText: marker }).first(),
  ).toBeVisible({ timeout: 90_000 });
});
