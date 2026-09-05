import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoImg,
} from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { renderedAuthV2LinkContrast } from "./auth-v2-style-assertions.ts";

const context = testContext();
const OKOU_HOME_URL = "https://app.okou.ai/";

function linkByText(text: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === text;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Expected link named ${text}`);
  }
  return link;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button labelled ${label}`);
  }
  return button;
}

function authV2BrandImage(): HTMLImageElement {
  const image = screen.getByTestId("auth-v2-brand-logo").querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    throw new Error("Expected an authentication brand image");
  }
  return image;
}

test("Authentication link actions remain readable in light and dark themes", async () => {
  context.mocks.browser.matchMedia(false);
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
  });

  const signUp = await waitFor(() => {
    return linkByText("Sign up");
  });
  const surface = screen.getByTestId("app-auth-v2");
  await expect(
    renderedAuthV2LinkContrast(signUp, surface, "light", context.signal),
  ).resolves.toBeGreaterThanOrEqual(4.5);

  click(buttonByLabel("Toggle theme"));

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
  await expect(
    renderedAuthV2LinkContrast(signUp, surface, "dark", context.signal),
  ).resolves.toBeGreaterThanOrEqual(4.5);
});

test("Okou authentication uses the wordmark for the active theme", async () => {
  context.mocks.browser.matchMedia(false);

  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: `/sign-in?redirect_url=${encodeURIComponent(OKOU_HOME_URL)}`,
  });

  const homeWordmark = await screen.findByRole("img", { name: "Okou" });
  expect(homeWordmark).toHaveAttribute("src", platformOkouWordmarkDarkImg);
  expect(authV2BrandImage()).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );

  click(buttonByLabel("Toggle theme"));

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(homeWordmark).toHaveAttribute("src", platformOkouWordmarkLightImg);
    expect(authV2BrandImage()).toHaveAttribute(
      "src",
      platformOkouWordmarkLightImg,
    );
  });
});

test("The authentication theme can be toggled by pointer and keyboard", async () => {
  const user = userEvent.setup({ delay: null });
  context.mocks.browser.matchMedia(false);
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
  });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(screen.getByRole("heading", { name: "Sign in to VM0" })).toBeVisible();
  const themeToggle = buttonByLabel("Toggle theme");
  expect(themeToggle).toHaveAttribute("aria-pressed", "false");

  await user.click(themeToggle);

  await waitFor(() => {
    expect(themeToggle).toHaveFocus();
    expect(themeToggle).toHaveAttribute("aria-pressed", "true");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });
  expect(screen.getByRole("status")).toHaveTextContent("Dark theme enabled");
  expect(screen.getByAltText("VM0")).toHaveAttribute("src", platformVm0LogoImg);
  expect(screen.getByTestId("auth-v2-brand-logo")).toHaveAttribute(
    "src",
    platformVm0LogoImg,
  );

  await user.keyboard("{Enter}");

  await waitFor(() => {
    expect(themeToggle).toHaveAttribute("aria-pressed", "false");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
  expect(screen.getByRole("status")).toHaveTextContent("Light theme enabled");
});
