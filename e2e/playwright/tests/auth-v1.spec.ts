import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";

import { expect, test } from "../fixtures";
import {
  createUser,
  deleteUserByEmail,
  generateTestEmail,
} from "../lib/clerk-api";

async function openAuth(
  page: Page,
  path: "/v1/sign-in" | "/v1/sign-up",
  theme: "light" | "dark",
): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  // Never submit these fixtures against a production Clerk instance.
  await expect(
    page.locator("script[data-clerk-publishable-key]").first(),
  ).toHaveAttribute("data-clerk-publishable-key", /^pk_test_/);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const toggle = page.getByRole("button", { name: "Toggle theme" });
  if (
    (await toggle.getAttribute("aria-pressed")) !== String(theme === "dark")
  ) {
    await toggle.click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expectLogo(page);
}

async function expectLogo(page: Page): Promise<void> {
  const logo = page.locator(".cl-logoBox");
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS("height", "20px");
  // Clerk's root is block on desktop and flex on mobile by default. Outside
  // branding needs an explicit column so its DS gap applies at both widths.
  // Google One Tap has a second Clerk root; only the auth form owns this gap.
  const root = page.locator(".okou-clerk-root");
  await expect(root).toHaveCSS("display", "flex");
  await expect(root).toHaveCSS("row-gap", "20px");
  await expect
    .poll(async () => {
      const brand = await logo.boundingBox();
      const card = await page.locator(".cl-cardBox").boundingBox();
      if (!brand || !card) throw new Error("Expected the brand and auth card");
      return card.y - (brand.y + brand.height);
    })
    .toBeCloseTo(20, 1);
}

async function expectPrimary(page: Page, button: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(button).toHaveCSS("background-color", "rgb(255, 165, 0)");
  await expect(button).toHaveCSS("color", "rgb(36, 35, 33)");
  await expect(button).toHaveCSS("height", "36px");
  await expect(button).toHaveCSS("text-decoration-line", "none");
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
      isMobile: device.name === "mobile dark",
      hasTouch: device.name === "mobile dark",
      viewport: { width: device.width, height: device.height },
    });

    test("hosted password feedback and reveal remain clear after reflow", async ({
      page,
    }) => {
      await openAuth(page, "/v1/sign-up", device.theme);
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

      await legalConsent.focus();
      await page.keyboard.press("Space");
      await expect(legalConsent).toBeChecked();
      await expect(legalConsent).toHaveCSS(
        "background-color",
        "rgb(255, 165, 0)",
      );
      await page.keyboard.press("Space");
      await expect(legalConsent).not.toBeChecked();
      const legalLinks = page.locator(".cl-formFieldCheckboxLabel a");
      await expect(legalLinks).toHaveCount(2);
      for (const link of await legalLinks.all()) {
        await expect(link).toHaveCSS(
          "color",
          device.theme === "light" ? "rgb(136, 86, 0)" : "rgb(255, 165, 0)",
        );
        await expect(link).toHaveCSS("text-decoration-line", "underline");
      }
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
      await openAuth(page, "/v1/sign-up", device.theme);
      await page
        .getByLabel("Email address", { exact: true })
        .fill(`auth-v1-${randomUUID()}+clerk_test@example.com`);
      await page
        .getByLabel("Password", { exact: true })
        .fill("A-Strong-Password-For-OTP-Layout!2026");
      await page.getByRole("checkbox").check();
      await expectPrimary(
        page,
        page.getByRole("button", { exact: true, name: "Continue" }),
      );
      await page.getByRole("button", { exact: true, name: "Continue" }).click();

      const inputs = page.locator(".cl-otpCodeFieldInputs");
      const error = page.locator(".cl-otpCodeFieldErrorText:visible");
      const resend = page.locator(".cl-formResendCodeLink");
      await expect(inputs).toBeVisible();
      await expectLogo(page);
      const code = page.getByRole("textbox", {
        name: "Enter verification code",
      });
      await code.fill("1");
      const activeSlot = page.locator(".cl-otpCodeFieldInput").nth(1);
      await expect(activeSlot).toHaveCSS("border-color", "rgb(255, 165, 0)");
      await expect(activeSlot).toHaveCSS("box-shadow", /3px/);
      await code.clear();
      await enterInvalidCode(page, "000000");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      for (const slot of await page.locator(".cl-otpCodeFieldInput").all()) {
        await expect(slot).toHaveCSS(
          "border-color",
          device.theme === "light" ? "rgb(188, 53, 0)" : "rgb(255, 144, 113)",
        );
      }

      await page.setViewportSize({ width: 375, height: 812 });
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      await enterInvalidCode(page, "000001");
      await expect(error).not.toBeEmpty();
      await expectSeparated(inputs, error);
      await expectSeparated(error, resend);
      // Do not verify the signup: no user or active session is created.
    });

    test("hosted sign-in preserves help and recovery hierarchy through navigation", async ({
      page,
    }) => {
      const email = generateTestEmail("playwright");
      const password = `Auth-Layout!${randomUUID()}`;
      if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")) {
        throw new Error("Auth layout fixtures require a development Clerk key");
      }
      if (process.env.CI) {
        console.log(`::add-mask::${email}`);
        console.log(`::add-mask::${password}`);
      }
      try {
        await createUser(email, password);
        await openAuth(page, "/v1/sign-in", device.theme);
        const passkey = page.locator(
          ".cl-footerAction__usePasskey .cl-footerActionLink",
        );
        if (await passkey.count()) {
          await expect(passkey).toHaveCSS("height", "36px");
          await expect(passkey).toHaveCSS("text-decoration-line", "none");
          const target = await passkey.boundingBox();
          const row = await page
            .locator(".cl-footerAction__usePasskey")
            .boundingBox();
          if (!target || !row)
            throw new Error("Expected the passkey action and row");
          expect(Math.abs(target.width - row.width)).toBeLessThanOrEqual(1);
        }
        await page.getByLabel("Email address", { exact: true }).fill(email);
        await page
          .getByRole("button", { exact: true, name: "Continue" })
          .click();
        await expect(
          page.getByLabel("Password", { exact: true }),
        ).toBeVisible();
        await expectLogo(page);

        const otherMethod = page.getByRole("link", {
          name: "Use another method",
        });
        await expect(otherMethod).toHaveCSS("text-decoration-line", "none");
        await otherMethod.click();
        const emailMethod = page.getByRole("button", { name: /email code/i });
        await expect(emailMethod).toBeVisible();
        await expect(
          emailMethod.locator(".cl-alternativeMethodsBlockButtonText"),
        ).toHaveCSS("text-align", "left");
        await expect(
          emailMethod.locator(".cl-alternativeMethodsBlockButtonArrow"),
        ).toHaveCSS("opacity", "1");
        await expect(
          emailMethod.locator(".cl-alternativeMethodsBlockButtonArrow"),
        ).toHaveCSS("transform", "none");

        await page.getByRole("link", { name: "Get help" }).click();
        await expectPrimary(
          page,
          page.getByRole("button", { name: /email support/i }),
        );
        await expectLogo(page);
        const back = page.getByRole("link", { exact: true, name: "Back" });
        await expect(back).toHaveCSS("text-decoration-line", "none");
        await back.hover();
        await expect(back).toHaveCSS("text-decoration-line", "none");
        await back.click();
        await page.getByRole("link", { name: "Back", exact: true }).click();
        await expect(
          page.getByLabel("Password", { exact: true }),
        ).toBeVisible();

        await page.getByRole("link", { name: /forgot password/i }).click();
        const reset = page.getByRole("button", {
          name: /reset your password/i,
        });
        await expectPrimary(page, reset);
        await expect(reset).toHaveCSS("justify-content", "center");
        await reset.click();
        await expectLogo(page);
        await enterInvalidCode(page, "000000");
        await expectSeparated(
          page.locator(".cl-otpCodeFieldInputs"),
          page.locator(".cl-otpCodeFieldErrorText:visible"),
        );
        // Do not complete a reset or activate a session. The exact test user
        // is removed below, with the CI generation finalizer as crash cleanup.
      } finally {
        await deleteUserByEmail(email);
      }
    });
  });
}
