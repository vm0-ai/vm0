import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { initializeI18n } from "../../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../../i18n/resources.ts";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { reportForceUpgradeRequired } from "../../../signals/force-upgrade.ts";
import { setLocale$ } from "../../../signals/locale.ts";

const context = testContext();

beforeEach(async () => {
  await initializeI18n(DEFAULT_LOCALE);
  await context.store.set(setLocale$, DEFAULT_LOCALE, context.signal);
});

function mockAPIs(): void {
  context.mocks.data.agents([
    {
      agentId: "c0000000-0000-4000-a000-000000000001",
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
    },
  ]);
}

describe("link navigation", () => {
  it("renders the not found page for unknown routes", async () => {
    mockAPIs();
    detachedSetupPage({ context, path: "/missing-platform-route" });

    const homeLink = await waitFor(() => {
      const homeLink = queryAllByRoleFast("link").find((link) => {
        return link.textContent?.trim() === "Back to home";
      });

      expect(
        screen.getByRole("heading", { name: "Page not found" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("The page you are looking for does not exist."),
      ).toBeInTheDocument();
      expect(homeLink).toHaveAttribute("href", "/");
      return homeLink;
    });

    fireEvent.click(homeLink!);

    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Page not found" }),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("labeled-nav-rail")).getByText("Agents"),
      ).toBeInTheDocument();
    });
  });

  it("localizes shared not-found, error, and force-upgrade states", async () => {
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    detachedSetupPage({
      context,
      path: "/missing-platform-route",
    });

    await screen.findByRole("heading", { name: "Página não encontrada" });
    expect(
      screen.getByText("A página que você procura não existe."),
    ).toBeInTheDocument();
    const homeLink = queryAllByRoleFast("link").find((link) => {
      return link.textContent?.trim() === "Voltar ao início";
    });
    expect(homeLink).toHaveAttribute("href", "/");

    reportForceUpgradeRequired();

    const upgradeDialog = await screen.findByRole("dialog", {
      name: "Atualização necessária",
    });
    expect(upgradeDialog).toHaveTextContent(
      "Esta versão do VM0 não é mais compatível.",
    );
    const refreshButton = queryAllByRoleFast("button", upgradeDialog).find(
      (button) => {
        return button.textContent?.trim() === "Atualizar";
      },
    );
    expect(refreshButton).toBeDefined();
  });

  it("localizes the shared error page", async () => {
    context.mocks.browser.url("https://app.vm0.ai/_/error");
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    detachedSetupPage({
      context,
      path: "/_/error",
    });

    await waitFor(() => {
      expect(screen.getByText("Ops! Algo deu errado")).toBeInTheDocument();
      expect(
        screen.getByText(/Tente novamente ou fale com o/u),
      ).toBeInTheDocument();
      expect(screen.getByText("suporte")).toHaveAttribute(
        "href",
        "mailto:contact@vm0.ai",
      );
    });
  });

  it("uses the Okou contact address on the Okou error page", async () => {
    context.mocks.browser.url("https://app.okou.ai/_/error");

    detachedSetupPage({
      context,
      path: "/_/error",
    });

    await waitFor(() => {
      expect(screen.getByText("support")).toHaveAttribute(
        "href",
        "mailto:contact@okou.ai",
      );
    });
  });

  it("navigates in-app normally and opens a new tab for modified clicks", async () => {
    mockAPIs();
    const openedTargets = context.mocks.browser.open();

    detachedSetupPage({ context, path: "/" });

    const link = await waitFor(() => {
      const rail = screen.getByTestId("labeled-nav-rail");
      return within(rail).getByText("Agents").closest("a");
    });
    expect(link).not.toBeNull();

    fireEvent.click(link!);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: /agents/i }),
      ).toBeInTheDocument();
    });
    expect(openedTargets.calls).toStrictEqual([]);

    fireEvent.click(link!, { metaKey: true });

    await waitFor(() => {
      expect(openedTargets.calls).toStrictEqual([
        expect.objectContaining({
          target: "_blank",
          url: expect.stringContaining("/agents"),
        }),
      ]);
    });
  });

  it("completes a sign-in token route and returns home", async () => {
    mockAPIs();

    detachedSetupPage({
      context,
      path: "/sign-in-token?token=clerk-ticket",
      user: null,
      session: null,
    });

    await waitFor(() => {
      expect(pathname()).toBe("/");
    });
    expect(mockedClerk.clientSignInCreate).toHaveBeenCalledWith({
      strategy: "ticket",
      ticket: "clerk-ticket",
    });
    expect(mockedClerk.setActive).toHaveBeenCalledWith({
      navigate: expect.any(Function),
      session: "test-created-session-id",
    });
  });
});
