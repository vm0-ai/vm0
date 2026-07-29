import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { platformVm0LogoDarkImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { i18n } from "../../../i18n/index.ts";
import { getClerkLocalization } from "../clerk-localization.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  window.location.href = url;
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

describe("app auth pages", () => {
  it("localizes the app auth shell and Clerk resources in Brazilian Portuguese", async () => {
    usePortugueseLocale();
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    detachedSetupPage({ context, path: "/sign-up" });

    await expect(
      screen.findByText("Carregando autenticação"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Alternar tema")).toBeInTheDocument();
    expect(document.title).toBe("Criar conta | VM0");

    const localization = getClerkLocalization("VM0", "pt-BR", i18n.t);
    expect(localization.signIn?.start?.actionLink).toBe("Registre-se");
    expect(localization.unstable__errors?.not_allowed_access).toBe(
      "Acesso não permitido.",
    );

    act(() => {
      authComponent.mount();
    });
  });

  it("mounts the Clerk sign-up route before Clerk finishes loading", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const clerkLoad = createDeferredPromise<void>(context.signal);
    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    mockedClerk.load.mockImplementation(() => {
      return clerkLoad.promise;
    });

    detachedSetupPage({ context, path: "/sign-up" });

    const appSkeleton = await screen.findByTestId("app-skeleton");
    expect(appSkeleton).not.toHaveAttribute("aria-hidden");
    await expect(
      screen.findByTestId("clerk-auth-loading"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByTestId("clerk-sign-up")).toBeEmptyDOMElement();

    await act(async () => {
      clerkLoad.resolve();
      await clerkLoad.promise;
    });

    expect(screen.getByTestId("clerk-auth-loading")).toBeInTheDocument();
    expect(appSkeleton).not.toHaveAttribute("aria-hidden");

    act(() => {
      authComponent.mount();
    });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toHaveTextContent("/sign-up");
      expect(appSkeleton).toHaveAttribute("aria-hidden", "true");
    });
    expect(screen.queryByTestId("clerk-auth-loading")).not.toBeInTheDocument();
  });

  it("renders the app-hosted sign-in route", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in");

    detachedSetupPage({ context, path: "/sign-in" });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-routing",
      "path",
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-in-force-redirect-url",
      "https://app.vm0.ai",
    );
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-up-force-redirect-url",
      "https://app.vm0.ai",
    );
    expect(screen.getByAltText("VM0")).toHaveAttribute(
      "src",
      platformVm0LogoDarkImg,
    );
  });

  it("routes nested sign-in task paths to the Clerk sign-in surface", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in/tasks/choose-organization");

    detachedSetupPage({
      context,
      path: "/sign-in/tasks/choose-organization",
    });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveTextContent("/sign-in");
    expect(
      screen.queryByTestId("clerk-google-one-tap"),
    ).not.toBeInTheDocument();
  });

  it("renders the app-hosted sign-in route with an allowed redirect URL", async () => {
    const redirectUrl = "https://app.vm0.ai/_/skeleton";
    const path = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-fallback-redirect-url",
      redirectUrl,
    );
    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
  });

  it("allows sign-in redirects to okou.ai subdomains", async () => {
    const redirectUrl = "https://console.okou.ai/_/skeleton";
    const path = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
  });

  it("renders the app-hosted sign-in route when URL.canParse is unavailable", async () => {
    const originalCanParse = URL.canParse;
    Object.defineProperty(URL, "canParse", {
      configurable: true,
      value: undefined,
    });

    try {
      const redirectUrl = "https://app.vm0.ai/_/skeleton";
      const path = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
      setBrowserUrl(`https://app.vm0.ai${path}`);

      detachedSetupPage({ context, path });

      await waitFor(() => {
        expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
      });

      expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
        "data-clerk-fallback-redirect-url",
        redirectUrl,
      );
      expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
        "data-clerk-force-redirect-url",
        redirectUrl,
      );
    } finally {
      Object.defineProperty(URL, "canParse", {
        configurable: true,
        value: originalCanParse,
      });
    }
  });

  it("ignores malformed sign-in redirect URLs when URL.canParse is unavailable", async () => {
    const originalCanParse = URL.canParse;
    Object.defineProperty(URL, "canParse", {
      configurable: true,
      value: undefined,
    });

    try {
      const path = `/sign-in?redirect_url=${encodeURIComponent("https://[")}`;
      setBrowserUrl(`https://app.vm0.ai${path}`);

      detachedSetupPage({ context, path });

      await waitFor(() => {
        expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
      });

      expect(
        screen.getByTestId("clerk-sign-in").dataset.clerkFallbackRedirectUrl,
      ).toBe("https://app.vm0.ai");
      expect(
        screen.getByTestId("clerk-sign-in").dataset.clerkForceRedirectUrl,
      ).toBe("https://app.vm0.ai");
    } finally {
      Object.defineProperty(URL, "canParse", {
        configurable: true,
        value: originalCanParse,
      });
    }
  });

  it("renders the app-hosted sign-up route with an allowed redirect URL", async () => {
    const redirectUrl = "https://app.vm0.ai/prompt";
    const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-routing",
      "path",
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-fallback-redirect-url",
      redirectUrl,
    );
    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
    expect(
      screen.queryByTestId("clerk-google-one-tap"),
    ).not.toBeInTheDocument();
  });

  it("keeps app-hosted auth pages scrollable inside the root safe area", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-up");

    detachedSetupPage({ context, path: "/sign-up" });

    const layout = await screen.findByTestId("app-auth-layout");

    expect(layout).toHaveClass("h-full");
    expect(layout).toHaveClass("min-h-0");
    expect(layout).toHaveClass("overflow-y-auto");
    expect(layout).toHaveClass("overflow-x-hidden");
    expect(layout).toHaveClass("p-6");
    expect(layout).not.toHaveClass("overflow-hidden");
    expect(layout.className).not.toContain("var(--sat)");
    expect(layout.className).not.toContain("var(--sab)");

    const logo = screen.getByAltText("VM0").closest("a");
    expect(logo).toHaveClass("left-6");
    expect(logo).toHaveClass("top-6");
    expect(logo?.className).not.toContain("var(--sat)");

    const themeToggle = screen.getByLabelText("Toggle theme");
    expect(themeToggle.className).toContain("var(--sat)");
    expect(themeToggle.className).toContain("var(--sar)");
  });

  it("routes ad-attributed sign-up visits through onboarding", async () => {
    const path = "/sign-up?gclid=click-123&utm_campaign=summer";
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    const redirectUrl = new URL(
      screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl ?? "",
    );
    expect(redirectUrl.origin).toBe("https://app.vm0.ai");
    expect(redirectUrl.pathname).toBe("/onboarding");
    expect(redirectUrl.searchParams.get("gclid")).toBe("click-123");
    expect(redirectUrl.searchParams.get("utm_campaign")).toBe("summer");
    expect(redirectUrl.searchParams.get("vm0_source")).toBe("homepage");
  });

  it("keeps sign-up redirects to sibling origins of the current host", async () => {
    const redirectUrl = "https://www.vm0.ai/connector/success?vm0_theme=light";
    const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
    ).toBe(redirectUrl);
  });

  it("drops sign-up redirects to other environments", async () => {
    const redirectUrl = "https://staging-www.omby.ai/connector/success";
    const path = `/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(
      screen.getByTestId("clerk-sign-up").dataset.clerkForceRedirectUrl,
    ).toBe("https://app.vm0.ai");
  });
});
