import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  mockedClerk,
  mockSignInResource,
} from "../../../__tests__/mock-auth.ts";
import { changeI18nLanguage } from "../../../i18n/index.ts";
import {
  platformOkouWordmarkDarkImg,
  platformOkouWordmarkLightImg,
  platformVm0LogoImg,
} from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { renderedAuthV2LinkContrast } from "./auth-v2-style-assertions.ts";

const context = testContext();
const OKOU_HOME_URL = "https://app.okou.ai/";

function linkByLabel(label: string): HTMLAnchorElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`Expected link labelled ${label}`);
  }
  return link;
}

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

function containingForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) {
    throw new Error("Expected element to be inside a form");
  }
  return form;
}

function authV2BrandImage(): HTMLImageElement {
  const image = screen.getByTestId("auth-v2-brand-logo").querySelector("img");
  if (!(image instanceof HTMLImageElement)) {
    throw new Error("Expected an authentication brand image");
  }
  return image;
}

function authLayout(): HTMLElement {
  return screen.getByTestId("app-auth-layout");
}

function authBackground(): HTMLElement {
  return screen.getByTestId("app-auth-background");
}

test("Decorative sign-in artwork stays inside its visual layer", async () => {
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-in",
  });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  const layout = authLayout();
  const background = authBackground();
  expect(background.parentElement).toBe(layout);
  expect(background).toHaveAttribute("aria-hidden", "true");
  expect(background).toHaveClass("absolute", "inset-0", "overflow-hidden");
  expect(background.children.length).toBeGreaterThan(0);
});

test("A constrained sign-up keeps its content scrollable", async () => {
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: "/sign-up",
  });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  expect(authLayout()).toHaveClass("overflow-x-hidden", "overflow-y-auto");
  expect(authLayout()).not.toHaveClass("overflow-hidden");
  expect(authBackground()).toHaveClass("overflow-hidden");
});

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

test("Okou authentication localizes app copy while keeping English startup metadata", async () => {
  context.mocks.browser.matchMedia(false);
  mockSignInResource({ status: "needs_identifier" });
  mockedClerk.clientSignInCreate.mockImplementation(() => {
    mockSignInResource({
      status: "needs_first_factor",
      supportedFirstFactors: [{ strategy: "password" }],
    });
    return Promise.resolve(mockedClerk.client.signIn);
  });
  await setupPage({
    auth: null,
    context,
    host: "app.vm0.ai",
    path: `/sign-up?redirect_url=${encodeURIComponent(OKOU_HOME_URL)}`,
  });

  await expect(screen.findByLabelText("Email address")).resolves.toBeVisible();
  await act(async () => {
    document.documentElement.lang = "ja-JP";
    await changeI18nLanguage("ja-JP", context.signal);
  });

  await expect(screen.findByLabelText("メールアドレス")).resolves.toBeVisible();
  expect(
    screen.getByRole("region", { name: "アカウントを作成" }),
  ).toHaveAccessibleDescription("ようこそ！始めるには詳細を入力してください");
  expect(linkByLabel("Okou のホームに移動")).toHaveAttribute(
    "href",
    "https://app.okou.ai",
  );
  expect(screen.getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
  expect(authV2BrandImage()).toHaveAttribute(
    "src",
    platformOkouWordmarkDarkImg,
  );
  expect(screen.queryByRole("img", { name: "VM0" })).not.toBeInTheDocument();
  expect(document.title).toBe("Sign up | Okou");

  await act(async () => {
    document.documentElement.lang = "de-DE";
    await changeI18nLanguage("de-DE", context.signal);
  });

  await expect(screen.findByLabelText("E-Mail-Adresse")).resolves.toBeVisible();
  expect(
    screen.getByRole("region", { name: "Ihr Konto erstellen" }),
  ).toHaveAccessibleDescription("weiter zu Okou");
  expect(document.body).not.toHaveTextContent("{{brandName}}");

  await act(async () => {
    document.documentElement.lang = "en-US";
    await changeI18nLanguage("en-US", context.signal);
  });
  const signIn = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("href")?.startsWith("/sign-in");
  });
  if (!signIn) {
    throw new Error("Expected the existing-account sign-in link");
  }
  click(signIn);
  const identifierInput = await screen.findByLabelText("Email address");
  await fill(identifierInput, "person@example.com");
  fireEvent.submit(containingForm(identifierInput));

  await expect(screen.findByLabelText("Password")).resolves.toBeVisible();
  expect(
    screen.getByRole("region", { name: "Enter your password" }),
  ).toHaveAccessibleDescription(
    "Enter the password associated with your account",
  );
  expect(document.body).not.toHaveTextContent("{{brandName}}");
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
