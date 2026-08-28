import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  platformVm0LogoDarkImg,
  platformVm0LogoImg,
} from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { renderedAuthV2ActionContrast } from "./auth-v2-style-assertions.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  context.mocks.browser.url(url);
}

function useJapaneseLocale(): void {
  document.documentElement.lang = "ja-JP";
  context.mocks.data.userPreferences({
    locale: "ja-JP",
    supportedLocales: ["en-US", "ja-JP"],
  });
}

function useGermanLocale(): void {
  document.documentElement.lang = "de-DE";
  context.mocks.data.userPreferences({
    locale: "de-DE",
    supportedLocales: ["de-DE", "en-US"],
  });
}

function linkByLabel(label: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Link not found: ${label}`);
  }
  return link;
}

function linkByText(text: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Link not found: ${text}`);
  }
  return link;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("auth v2 presentation", () => {
  it("provides branded landmarks, descriptions, announcements, and initial focus", async () => {
    setBrowserUrl("https://app.vm0.ai/v2/sign-in");

    detachedSetupPage({ context, path: "/v2/sign-in" });

    await screen.findByRole("heading", {
      level: 1,
      name: "Choose an account",
    });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "Choose an account",
        }),
      ).toHaveFocus();
    });
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Choose an account",
    });

    const styleElement = document.createElement("style");
    const tailwindCompiler = await compile("@tailwind utilities;");
    styleElement.textContent = [
      "h1 { box-shadow: none; }",
      tailwindCompiler.build([...heading.classList]),
    ].join("\n");
    document.head.append(styleElement);
    context.signal.addEventListener(
      "abort",
      () => {
        styleElement.remove();
      },
      { once: true },
    );
    const headingStyle = getComputedStyle(heading);
    expect(headingStyle.boxShadow).toBe("none");
    expect(headingStyle.outlineStyle).toBe("none");
    expect(screen.getByRole("main")).toContainElement(heading);
    expect(
      screen.getByRole("region", { name: "Choose an account" }),
    ).toHaveAccessibleDescription(
      "Select the account with which you wish to continue.",
    );
    expect(screen.getByTestId("auth-v2-brand-logo")).toHaveAttribute(
      "src",
      platformVm0LogoDarkImg,
    );
    expect(linkByLabel("Go to VM0 home")).toHaveAttribute("href", "/");

    const announcer = screen.getByTestId("auth-v2-announcer");
    expect(announcer).toHaveAttribute("aria-atomic", "true");
    expect(announcer).toHaveAttribute("aria-live", "polite");
  });

  it("keeps password controls in their accessible region", async () => {
    setBrowserUrl("https://app.vm0.ai/v2/sign-up");

    detachedSetupPage({ context, path: "/v2/sign-up" });

    await screen.findByLabelText("Password");
    const region = screen.getByTestId("app-auth-v2");
    const passwordVisibilityAction = buttonByLabel("Show password");

    expect(region).toContainElement(passwordVisibilityAction);
    expect(passwordVisibilityAction).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps primary and link actions at WCAG AA contrast in both themes", async () => {
    const user = userEvent.setup();
    context.mocks.browser.matchMedia(false);
    setBrowserUrl("https://app.vm0.ai/v2/sign-in");

    detachedSetupPage({
      context,
      path: "/v2/sign-in",
      session: null,
      user: null,
    });

    const primaryAction = await waitFor(() => {
      return buttonByLabel("Continue");
    });
    const linkAction = await waitFor(() => {
      return linkByText("Sign up");
    });
    const surface = screen.getByTestId("app-auth-v2");
    const lightContrast = await renderedAuthV2ActionContrast(
      primaryAction,
      linkAction,
      surface,
      "light",
      context.signal,
    );
    expect(lightContrast.primary).toBeGreaterThanOrEqual(4.5);
    expect(lightContrast.link).toBeGreaterThanOrEqual(4.5);

    await user.click(buttonByLabel("Toggle theme"));

    const darkContrast = await renderedAuthV2ActionContrast(
      primaryAction,
      linkAction,
      surface,
      "dark",
      context.signal,
    );
    expect(darkContrast.primary).toBeGreaterThanOrEqual(4.5);
    expect(darkContrast.link).toBeGreaterThanOrEqual(4.5);
  });

  it("toggles themes with pointer and keyboard input while preserving focus", async () => {
    const user = userEvent.setup();
    context.mocks.browser.matchMedia(false);
    setBrowserUrl("https://app.vm0.ai/v2/sign-in");

    detachedSetupPage({ context, path: "/v2/sign-in" });

    await screen.findByRole("heading", {
      name: "Sign in to VM0",
    });
    const themeToggle = buttonByLabel("Toggle theme");
    expect(themeToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(themeToggle);

    expect(themeToggle).toHaveFocus();
    expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(screen.getByRole("status")).toHaveTextContent("Dark theme enabled");
    expect(screen.getByAltText("VM0")).toHaveAttribute(
      "src",
      platformVm0LogoImg,
    );
    expect(screen.getByTestId("auth-v2-brand-logo")).toHaveAttribute(
      "src",
      platformVm0LogoImg,
    );

    await user.keyboard("{Enter}");

    expect(themeToggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(screen.getByRole("status")).toHaveTextContent("Light theme enabled");
  });

  it("localizes the Okou presentation boundary through platform resources", async () => {
    useJapaneseLocale();
    setBrowserUrl("https://app.okou.ai/v2/sign-up");

    detachedSetupPage({ context, path: "/v2/sign-up" });

    await screen.findByLabelText("メールアドレス");
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "アカウントを作成",
    });
    expect(
      screen.getByRole("region", { name: "アカウントを作成" }),
    ).toHaveAccessibleDescription("ようこそ！始めるには詳細を入力してください");
    expect(linkByLabel("Okou のホームに移動")).toHaveAttribute("href", "/");
    expect(screen.queryByTestId("auth-v2-brand-logo")).not.toBeInTheDocument();
    expect(heading).toBeVisible();
    expect(document.title).toBe("サインアップ | Okou");
  });

  it("substitutes the Okou brand in a non-English Auth v2 template", async () => {
    useGermanLocale();
    setBrowserUrl("https://app.okou.ai/v2/sign-up");

    detachedSetupPage({ context, path: "/v2/sign-up" });

    await screen.findByLabelText("E-Mail-Adresse");
    expect(
      screen.getByRole("region", { name: "Ihr Konto erstellen" }),
    ).toHaveAccessibleDescription("weiter zu Okou");
    expect(document.body).not.toHaveTextContent("{{brandName}}");
  });
});
