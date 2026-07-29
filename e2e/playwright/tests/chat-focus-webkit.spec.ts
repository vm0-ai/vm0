import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

test("chat thread list separates pointer and keyboard focus indicators", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/agents\/.*\/chat/, { timeout: 30_000 });

  await page.getByLabel("Open chat list menu").click();
  await page.getByRole("menuitem", { name: "New chat" }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]+$/, { timeout: 30_000 });

  const scrollArea = page.getByTestId("sidebar-scroll-area");
  const currentThread = scrollArea.locator(
    '[data-sidebar-chat-thread-id][aria-current="page"]',
  );
  await expect(currentThread).toBeVisible();

  const bounds = await scrollArea.boundingBox();
  if (!bounds) {
    throw new Error("Chat thread scroll area has no visible bounds");
  }

  await page.mouse.click(bounds.x + 4, bounds.y + bounds.height - 4);
  await expect(scrollArea).toBeFocused();

  const pointerFocusStyle = await scrollArea.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
    };
  });
  expect(pointerFocusStyle).toEqual({
    boxShadow: "none",
    focusVisible: false,
    outlineStyle: "none",
  });

  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(currentThread).toBeFocused();

  const keyboardFocusStyle = await currentThread.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
    };
  });
  expect(keyboardFocusStyle.focusVisible).toBe(true);
  expect(keyboardFocusStyle.outlineStyle).toBe("none");
  expect(keyboardFocusStyle.boxShadow).toContain("inset");
});
