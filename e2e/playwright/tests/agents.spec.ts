import { expect, test } from "../fixtures";
import { deriveAppUrl } from "../playwright.config";

const appUrl = deriveAppUrl(process.env.VM0_API_BACKEND_URL!);

test("navigate to agents page and verify heading", async ({ page }) => {
  await page.goto(`${appUrl}/agents`);
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({
    timeout: 20_000,
  });
});

test("reveal the default agent unread action from the whole row", async ({
  page,
}) => {
  await page.goto(appUrl);
  await page.waitForURL(/\/agents\/[^/]+\/chat\/?$/, { timeout: 30_000 });
  const defaultAgentId = new URL(page.url()).pathname.match(
    /^\/agents\/([^/]+)\/chat\/?$/,
  )?.[1];
  if (!defaultAgentId) {
    throw new Error("Could not resolve the default agent from the sidebar");
  }

  await page.route("**/api/okou/chat-thread-unread-agents", async (route) => {
    await route.fulfill({ json: { agentIds: [defaultAgentId] } });
  });
  await page.reload();

  const defaultAgentRow = page.getByTestId("pinned-agent-card").filter({
    has: page.locator(`a[href="/agents/${defaultAgentId}/chat"]`),
  });
  const unreadIndicator = defaultAgentRow.getByLabel("Unread");
  const unreadContainer = unreadIndicator.locator("..");
  const menuTrigger = defaultAgentRow.getByLabel("Open agent menu");

  await expect(unreadIndicator).toBeAttached();
  await expect(menuTrigger).toHaveCSS("opacity", "0");
  await expect(unreadContainer).toHaveCSS("opacity", "1");
  const idleBackground = await menuTrigger.evaluate((element) => {
    return getComputedStyle(element).backgroundColor;
  });

  await defaultAgentRow.getByRole("link").hover({
    position: { x: 12, y: 16 },
  });
  await expect(menuTrigger).toHaveCSS("opacity", "1");
  await expect(unreadContainer).toHaveCSS("opacity", "0");

  await menuTrigger.click();
  await page.mouse.move(0, 0);

  await expect
    .poll(async () => {
      return defaultAgentRow.evaluate((element) => element.matches(":hover"));
    })
    .toBe(false);
  await expect(menuTrigger).toHaveCSS("opacity", "1");
  await expect(unreadContainer).toHaveCSS("opacity", "0");
  const activeBackground = await menuTrigger.evaluate((element) => {
    return getComputedStyle(element).backgroundColor;
  });
  expect(activeBackground).not.toBe(idleBackground);
  await expect(page.getByRole("menuitem")).toHaveCount(1);
  await expect(page.getByRole("menuitem")).toHaveText("Mark all read");
});
