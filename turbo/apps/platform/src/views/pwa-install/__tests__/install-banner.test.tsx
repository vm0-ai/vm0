import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { click, detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockIOSSafariUA(isIOS: boolean): void {
  const ua = isIOS
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  context.mocks.browser.userAgent(ua);
}

function usePortugueseLocale(): void {
  document.documentElement.lang = "pt-BR";
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

describe("install banner", () => {
  it("renders the iOS install flow in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    context.mocks.browser.standaloneDisplayMode(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    const installButton = await screen.findByLabelText("Instalar aplicativo");
    expect(
      screen.getByText("Instale o Zero para uma experiência melhor"),
    ).toBeVisible();
    click(installButton);

    await expect(
      screen.findByRole("heading", { name: "Instalar Zero" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("No Safari, toque no botão Compartilhar."),
    ).toBeVisible();
    expect(screen.getByText("Escolha Adicionar à Tela Inicial.")).toBeVisible();
  });

  it("lets an iOS Safari user open or dismiss the install prompt", async () => {
    context.mocks.browser.standaloneDisplayMode(false);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    const installButton = await waitFor(() => {
      expect(
        screen.getByLabelText("Dismiss install banner"),
      ).toBeInTheDocument();
      return screen.getByLabelText("Install app");
    });

    click(installButton);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Install Zero" }),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Dismiss install banner"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("Dismiss install banner"),
      ).not.toBeInTheDocument();
    });
  });

  it("hides the banner for a standalone app", async () => {
    context.mocks.browser.standaloneDisplayMode(true);
    mockIOSSafariUA(true);
    detachedSetupPage({ context, path: "/" });

    await waitFor(() => {
      expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Dismiss install banner"),
    ).not.toBeInTheDocument();
  });
});
