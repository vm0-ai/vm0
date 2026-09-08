import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";

async function openSignUp(page: Page): Promise<void> {
  await page.goto("/v1/sign-up", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  // Never submit these fixtures against a production Clerk instance.
  await expect(
    page.locator("script[data-clerk-publishable-key]").first(),
  ).toHaveAttribute("data-clerk-publishable-key", /^pk_test_/);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function expectSeparated(above: Locator, below: Locator): Promise<void> {
  await expect(above).toBeVisible();
  await expect(below).toBeVisible();
  await expect
    .poll(async () => {
      const upper = await above.boundingBox();
      const lower = await below.boundingBox();
      if (!upper || !lower) {
        throw new Error("Expected both adjacent controls to be rendered");
      }
      return lower.y - (upper.y + upper.height);
    })
    .toBeGreaterThanOrEqual(4);
}

async function expectPasswordControlFits(
  input: Locator,
  toggle: Locator,
): Promise<void> {
  await expect
    .poll(async () => {
      const field = await input.boundingBox();
      const button = await toggle.boundingBox();
      if (!field || !button) {
        throw new Error("Expected the password field and reveal control");
      }
      return Math.max(
        Math.abs(field.y - button.y),
        Math.abs(field.y + field.height - button.y - button.height),
        Math.abs(field.x + field.width - button.x - button.width),
      );
    })
    .toBeLessThanOrEqual(1);
  const trailingSpace = await input.evaluate((element) => {
    return parseFloat(getComputedStyle(element).paddingInlineEnd);
  });
  const button = await toggle.boundingBox();
  if (!button) throw new Error("Expected the reveal control to be rendered");
  expect(trailingSpace - button.width).toBeGreaterThanOrEqual(4);
}

async function enterInvalidCode(page: Page, code: string): Promise<void> {
  // Clerk's six visible slots are not inputs. The accessible textbox owns
  // typing/paste and resets after a rejected attempt. Wait for that visible
  // reset so retries cannot pass by observing the previous error.
  const input = page.getByRole("textbox", { name: "Enter verification code" });
  await expect(input).toHaveValue("");
  await input.fill(code);
  await expect(input).toHaveValue(code);
  await expect(input).toHaveValue("");
}

for (const device of [
  { name: "desktop light", theme: "light", width: 1440, height: 900 },
  { name: "mobile dark", theme: "dark", width: 390, height: 844 },
] as const) {
  test.describe(device.name, () => {
    test.use({
      colorScheme: device.theme,
      viewport: { width: device.width, height: device.height },
    });

    test("hosted password feedback and reveal remain clear after reflow", async ({
      page,
    }) => {
      await openSignUp(page);
      const password = page.getByLabel("Password", { exact: true });
      const error = page.locator(".cl-formFieldErrorText:visible");
      const legalConsent = page.getByRole("checkbox");

      await password.fill("a");
      await page.getByLabel("Email address", { exact: true }).focus();
      await expect(error).toContainText(/password/i);
      await expectSeparated(password, error);
      await expectSeparated(error, legalConsent);
      await page.setViewportSize({ width: 375, height: 812 });
      await expectSeparated(password, error);
      await expectSeparated(error, legalConsent);

      const longPassword = "A-Long-Password-For-Reveal-Layout!2026";
      await password.fill(longPassword);
      const show = page.getByRole("button", {
        exact: true,
        name: "Show password",
      });
      await expectPasswordControlFits(password, show);
      await show.focus();
      await page.keyboard.press("Enter");
      const hide = page.getByRole("button", {
        exact: true,
        name: "Hide password",
      });
      await expect(password).toHaveAttribute("type", "text");
      await expect(password).toHaveValue(longPassword);
      await expectPasswordControlFits(password, hide);
      await hide.click();
      await expect(password).toHaveAttribute("type", "password");
      await expectPasswordControlFits(password, show);
    });

    test("hosted signup keeps long OTP errors clear of inputs and resend on retry", async ({
      page,
    }) => {
      await openSignUp(page);
      await page
        .getByLabel("Email address", { exact: true })
        .fill(`auth-v1-${randomUUID()}+clerk_test@example.com`);
      await page
        .getByLabel("Password", { exact: true })
        .fill("A-Strong-Password-For-OTP-Layout!2026");
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { exact: true, name: "Continue" }).click();

      const inputs = page.locator(".cl-otpCodeFieldInputs");
      const error = page.locator(".cl-otpCodeFieldErrorText:visible");
      const resend = page.locator(".cl-formResendCodeLink");
      await expect(inputs).toBeVisible();
      await enterInvalidCode(page, "000000");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);

      await page.setViewportSize({ width: 375, height: 812 });
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      await enterInvalidCode(page, "000001");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      // Do not verify the signup: no user or active session is created.
    });
  });
}
