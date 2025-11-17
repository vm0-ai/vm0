import { test, expect } from "@playwright/test";

test.describe("Basic Smoke Tests", () => {
  test("homepage loads successfully", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveTitle(/VM0/i);

    const mainContent = page.locator('main, [role="main"], body').first();
    await expect(mainContent).toBeVisible();
  });

  test("API health check endpoint works", async ({ request }) => {
    const response = await request.get("/api/health");

    expect(response.status()).toBe(200);
  });

  test("navigation elements exist", async ({ page }) => {
    await page.goto("/");

    // Check for common navigation elements
    const navElements = await page.locator("nav, header, a[href], div").count();

    expect(navElements).toBeGreaterThan(0);
  });
});
