import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  type MockedMembership,
  mockedClerk,
} from "../../../__tests__/mock-auth.ts";
import { PRESENTATION_ONBOARDING_URL } from "../../../__tests__/presentation-onboarding-fixture.ts";
import type { SupportedLocale } from "../../../i18n/resources.ts";
import { platformVm0LogoDarkImg } from "../../../lib/static-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setLocale$ } from "../../../signals/locale.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function setBrowserUrl(url: string): void {
  context.mocks.browser.url(url);
}

function okouBrandLink(): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.trim() === "Okou";
  });
  if (!link) {
    throw new Error("Okou brand link not found");
  }
  return link;
}

function authV2Button(name: string): HTMLButtonElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Auth v2 button not found");
  }
  return button;
}

function setupChooseOrganizationPage(
  path: string,
  organization: { readonly id: string; readonly name: string },
): void {
  const membership: MockedMembership = {
    id: `membership_${organization.id}`,
    organization,
    role: "org:member",
  };
  detachedSetupPage({
    context,
    org: { activeOrg: null, memberships: [membership] },
    path,
    user: {
      clientSessions: [
        {
          currentTask: { key: "choose-organization" },
          id: "session_pending",
          status: "pending",
          user: {
            fullName: "Test User",
            organizationMemberships: [membership],
          },
        },
      ],
      fullName: "Test User",
      id: "test-user-123",
    },
  });
}

function disableUrlCanParse(): void {
  const urlWithoutCanParse = new Proxy(URL, {
    get(target, property, receiver) {
      return property === "canParse"
        ? undefined
        : Reflect.get(target, property, receiver);
    },
  });
  vi.stubGlobal("URL", urlWithoutCanParse);
}

function useLocale(locale: SupportedLocale): void {
  document.documentElement.lang = locale;
  context.mocks.data.userPreferences({ locale });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function useJapaneseLocale(): void {
  document.documentElement.lang = "ja-JP";
  context.mocks.data.userPreferences({
    locale: "ja-JP",
    supportedLocales: ["en-US", "ja-JP"],
  });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function useKoreanLocale(): void {
  document.documentElement.lang = "ko-KR";
  context.mocks.data.userPreferences({
    locale: "ko-KR",
    supportedLocales: ["en-US", "ko-KR"],
  });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function useGermanLocale(): void {
  document.documentElement.lang = "de-DE";
  context.mocks.data.userPreferences({
    locale: "de-DE",
    supportedLocales: ["en-US", "de-DE"],
  });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

function useSpanishLocale(): void {
  document.documentElement.lang = "es-ES";
  context.mocks.data.userPreferences({
    locale: "es-ES",
    supportedLocales: ["en-US", "es-ES"],
  });
  context.signal.addEventListener(
    "abort",
    () => {
      document.documentElement.lang = "en-US";
    },
    { once: true },
  );
}

describe("app auth pages", () => {
  const localeCases = [
    {
      locale: "pt-BR",
      loading: "Carregando autenticação",
      toggleTheme: "Alternar tema",
      documentTitle: "Criar conta | VM0",
      actionLink: "Registre-se",
      accessNotAllowed: "Acesso não permitido.",
    },
    {
      locale: "fr-FR",
      loading: "Chargement de l'authentification",
      toggleTheme: "Changer de thème",
      documentTitle: "S'inscrire | VM0",
      actionLink: "S'inscrire",
      accessNotAllowed: "L'accès n'est pas autorisé.",
    },
    {
      locale: "hi-IN",
      loading: "प्रमाणीकरण लोड हो रहा है",
      toggleTheme: "थीम टॉगल करें",
      documentTitle: "साइन अप करें | VM0",
      actionLink: "साइन अप करें",
      accessNotAllowed: "प्रवेश की अनुमति नहीं है।",
    },
  ] as const;

  it.each(localeCases)(
    "localizes the app auth shell and Clerk resources in $locale",
    async (localeCase) => {
      useLocale(localeCase.locale);
      setBrowserUrl("https://app.vm0.ai/sign-up");

      const authComponent = context.mocks.clerk.deferAuthComponentMount();
      detachedSetupPage({ context, path: "/sign-up" });

      await expect(
        screen.findByText(localeCase.loading),
      ).resolves.toBeInTheDocument();
      expect(screen.getByLabelText(localeCase.toggleTheme)).toBeInTheDocument();
      expect(document.title).toBe(localeCase.documentTitle);

      expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
        "data-clerk-sign-in-start-action-link",
        localeCase.actionLink,
      );
      expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
        "data-clerk-access-not-allowed-error",
        localeCase.accessNotAllowed,
      );

      act(() => {
        authComponent.mount();
      });
    },
  );

  it("localizes the app auth shell and Clerk resources in Japanese", async () => {
    useJapaneseLocale();
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    detachedSetupPage({ context, path: "/sign-up" });

    await expect(
      screen.findByText("認証を読み込み中"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("テーマの切り替え")).toBeInTheDocument();
    expect(document.title).toBe("サインアップ | VM0");

    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-action-link",
      "サインアップ",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-access-not-allowed-error",
      "アクセスは許可されていません。",
    );

    act(() => {
      authComponent.mount();
    });
  });

  it("localizes the app auth shell and Clerk resources in Korean", async () => {
    useKoreanLocale();
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    detachedSetupPage({ context, path: "/sign-up" });

    await expect(screen.findByText("인증 중")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("테마 전환")).toBeInTheDocument();
    expect(document.title).toBe("회원가입 | VM0");

    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-action-link",
      "회원가입",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-access-not-allowed-error",
      "접근이 허용되지 않습니다.",
    );

    act(() => {
      authComponent.mount();
    });
  });

  it("localizes the app auth shell and Clerk resources in German", async () => {
    useGermanLocale();
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    detachedSetupPage({ context, path: "/sign-up" });

    await expect(
      screen.findByText("Authentifizierung wird geladen"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Design wechseln")).toBeInTheDocument();
    expect(document.title).toBe("Registrieren | VM0");

    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-action-link",
      "Registrieren",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-access-not-allowed-error",
      "Zugriff nicht gestattet.",
    );

    act(() => {
      authComponent.mount();
    });
  });

  it("localizes the app auth shell and Clerk resources in Spanish", async () => {
    useSpanishLocale();
    setBrowserUrl("https://app.vm0.ai/sign-up");

    const authComponent = context.mocks.clerk.deferAuthComponentMount();
    detachedSetupPage({ context, path: "/sign-up" });

    await expect(
      screen.findByText("Cargando autenticación"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("Cambiar tema")).toBeInTheDocument();
    expect(document.title).toBe("Crear una cuenta | VM0");

    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-action-link",
      "Regístrese",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-access-not-allowed-error",
      "Acceso no permitido.",
    );

    act(() => {
      authComponent.mount();
    });
  });

  it("uses Italian Clerk resources", async () => {
    useLocale("it-IT");
    setBrowserUrl("https://app.vm0.ai/sign-up");

    detachedSetupPage({ context, path: "/sign-up" });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
        "data-clerk-sign-in-start-action-link",
        "Registrati",
      );
    });
  });

  it("updates the rendered Clerk provider after a runtime locale switch", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-up");
    detachedSetupPage({ context, path: "/sign-up" });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
        "data-clerk-sign-in-start-action-link",
        "Sign up",
      );
    });

    await act(async () => {
      await context.store.set(setLocale$, "fr-FR", context.signal);
    });

    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-action-link",
      "S'inscrire",
    );
    expect(document.documentElement.lang).toBe("fr-FR");
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

  it.each([
    {
      documentTitle: "Sign in | VM0",
      heading: "Sign in to VM0",
      path: "/v2/sign-in",
    },
    {
      documentTitle: "Sign up | VM0",
      heading: "Create your account",
      path: "/v2/sign-up",
    },
    {
      documentTitle: "Sign up | VM0",
      heading: "Create your account",
      path: "/v2/sign-up/verify-email-address",
    },
  ])("renders the auth v2 scaffold at $path", async (routeCase) => {
    setBrowserUrl(`https://app.vm0.ai${routeCase.path}`);

    detachedSetupPage({ context, path: routeCase.path });

    await expect(
      screen.findByRole("region", { name: routeCase.heading }),
    ).resolves.toBeVisible();
    expect(screen.getByTestId("app-auth-v2")).toBeVisible();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-up")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(document.title).toBe(routeCase.documentTitle);
  });

  it("recovers forced organization selection on a nested v2 task route", async () => {
    const path = "/v2/sign-in/tasks/choose-organization";
    setBrowserUrl(`https://app.vm0.ai${path}`);

    setupChooseOrganizationPage(path, {
      id: "org_route",
      name: "Route Organization",
    });

    await expect(
      screen.findByRole("region", { name: "Choose an organization" }),
    ).resolves.toBeVisible();
    expect(authV2Button("Continue with Route Organization")).toBeVisible();
    expect(screen.queryByText(/create organization/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(document.title).toBe("Sign in | VM0");
  });

  it("preserves branded auth intent through v2 continuation", async () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=auth-v2";
    const hash = "#/?step=identifier";
    const path = `/v2/sign-in/tasks/choose-organization?redirect_url=${encodeURIComponent(redirectUrl)}${hash}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    setupChooseOrganizationPage(path, {
      id: "org_okou",
      name: "Okou Organization",
    });

    await expect(
      screen.findByRole("region", { name: "Choose an organization" }),
    ).resolves.toBeVisible();
    expect(document.body).toHaveTextContent(
      "Choose an organization to continue to Okou.",
    );
    expect(document.title).toBe("Sign in | Okou");
    expect(okouBrandLink()).toHaveAttribute("href", "https://app.okou.ai");
    fireEvent.click(authV2Button("Continue with Okou Organization"));

    await waitFor(() => {
      expect(location.href).toBe(redirectUrl);
    });
  });

  it("renders the app-hosted sign-in route with an allowed redirect URL", async () => {
    const redirectUrl = PRESENTATION_ONBOARDING_URL;
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
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-user-banned-error",
      expect.stringContaining("support@vm0.ai"),
    );
  });

  it("allows sign-in redirects to okou.ai subdomains", async () => {
    const redirectUrl = "https://app.okou.ai/_/skeleton";
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
    expect(document.title).toBe("Sign in | Okou");
    expect(screen.queryByAltText("VM0")).not.toBeInTheDocument();
    expect(okouBrandLink()).toHaveAttribute("href", "https://app.okou.ai");
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-in-force-redirect-url",
      redirectUrl,
    );
    expect(screen.getByTestId("clerk-google-one-tap")).toHaveAttribute(
      "data-sign-up-force-redirect-url",
      redirectUrl,
    );

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-logo-placement",
      "none",
    );
    expect(screen.getByTestId("clerk-sign-in")).not.toHaveAttribute(
      "data-clerk-logo-image-url",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-start-title",
      "Sign in to Okou",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-sign-in-email-code-subtitle",
      "to continue to Okou",
    );
    expect(screen.getByTestId("clerk-provider-config")).toHaveAttribute(
      "data-clerk-user-banned-error",
      expect.stringContaining("support@okou.ai"),
    );
    expect(screen.getByTestId("clerk-provider-config")).not.toHaveAttribute(
      "data-clerk-touch-session",
    );
  });

  it("preserves Okou auth intent when Clerk moves the redirect into the hash", async () => {
    const redirectUrl = "https://app.okou.ai/onboarding?source=auth-switch";
    const hash = `#/?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai/sign-up${hash}`);

    detachedSetupPage({ context, path: "/sign-up" });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-up")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-up")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      redirectUrl,
    );
    expect(document.title).toBe("Sign up | Okou");
    expect(okouBrandLink()).toHaveAttribute("href", "https://app.okou.ai");
  });

  it("does not let an untrusted redirect URL control the auth brand", async () => {
    const redirectUrl = "https://app.okou.ai.evil.example/sign-in";
    const path = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
    setBrowserUrl(`https://app.vm0.ai${path}`);

    detachedSetupPage({ context, path });

    await waitFor(() => {
      expect(screen.getByTestId("clerk-sign-in")).toBeInTheDocument();
    });

    expect(screen.getByTestId("clerk-sign-in")).toHaveAttribute(
      "data-clerk-force-redirect-url",
      "https://app.vm0.ai",
    );
    expect(document.title).toBe("Sign in | VM0");
    expect(screen.getByAltText("VM0")).toHaveAttribute(
      "src",
      platformVm0LogoDarkImg,
    );
    expect(screen.queryByText("Okou")).not.toBeInTheDocument();
  });

  it("renders the app-hosted sign-in route when URL.canParse is unavailable", async () => {
    disableUrlCanParse();

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

  it("ignores malformed sign-in redirect URLs when URL.canParse is unavailable", async () => {
    disableUrlCanParse();

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
  });

  it("renders the app-hosted sign-up route with an allowed redirect URL", async () => {
    const redirectUrl = PRESENTATION_ONBOARDING_URL;
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

    const logoImage = screen.getByAltText("VM0");
    expect(logoImage).toHaveAttribute("crossorigin", "anonymous");

    const logo = logoImage.closest("a");
    expect(logo).toHaveClass("left-6");
    expect(logo).toHaveClass("top-6");
    expect(logo?.className).not.toContain("var(--sat)");

    const themeToggle = screen.getByLabelText("Toggle theme");
    expect(themeToggle.className).toContain("var(--sat)");
    expect(themeToggle.className).toContain("var(--sar)");
  });

  it("keeps Clerk checkboxes out of the shared text-input styling", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in");

    detachedSetupPage({ context, path: "/sign-in" });

    const clerkSurface = await screen.findByTestId("clerk-sign-in");
    const card = document.createElement("div");
    card.className = "cl-card";
    const checkbox = document.createElement("input");
    checkbox.className = "cl-formFieldInput cl-checkbox";
    checkbox.type = "checkbox";
    checkbox.checked = true;
    card.append(checkbox);
    clerkSurface.append(card);

    expect(getComputedStyle(checkbox).width).toBe("16px");
    expect(getComputedStyle(checkbox).height).toBe("16px");
  });

  it("presents the Clerk passkey action as a full-width outline control", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in");

    detachedSetupPage({ context, path: "/sign-in" });

    const clerkSurface = await screen.findByTestId("clerk-sign-in");
    const action = document.createElement("div");
    action.className = "cl-footerAction cl-footerAction__usePasskey";
    const link = document.createElement("a");
    link.className = "cl-footerActionLink cl-footerActionLink__usePasskey";
    link.href = "#";
    link.textContent = "Use passkey instead";
    action.append(link);
    clerkSurface.append(action);

    expect(getComputedStyle(action).width).toBe("100%");
    expect(getComputedStyle(link).display).toBe("inline-flex");
    expect(getComputedStyle(link).height).toBe("36px");
    expect(getComputedStyle(link).width).toBe("100%");
    expect(getComputedStyle(link).borderStyle).toBe("solid");
  });

  it("presents Clerk page actions with the standard button and link treatment", async () => {
    setBrowserUrl("https://app.vm0.ai/sign-in");

    detachedSetupPage({ context, path: "/sign-in" });

    const clerkSurface = await screen.findByTestId("clerk-sign-in");
    clerkSurface.style.setProperty("--primary", "20, 99%, 47%");
    clerkSurface.style.setProperty("--primary-foreground", "0, 0%, 100%");

    const primaryAction = document.createElement("button");
    primaryAction.className = "cl-formButtonPrimary";
    primaryAction.type = "submit";
    const primaryLabel = document.createElement("span");
    primaryLabel.textContent = "Continue";
    primaryAction.append(primaryLabel);

    const footerAction = document.createElement("div");
    footerAction.className = "cl-footerAction";
    const footerLink = document.createElement("a");
    footerLink.className = "cl-footerActionLink";
    footerLink.href = "/sign-up";
    footerLink.textContent = "Sign up";
    footerAction.append(footerLink);
    clerkSurface.append(primaryAction, footerAction);

    expect(getComputedStyle(primaryAction).backgroundColor).toBe(
      "hsl(20, 99%, 47%)",
    );
    expect(getComputedStyle(primaryLabel).color).toBe("hsl(0, 0%, 100%)");
    expect(getComputedStyle(footerLink).textDecoration).toBe("none");
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

  it("keeps sign-up attribution when the Clerk hash has no redirect", async () => {
    const path = "/sign-up?gclid=click-123&utm_campaign=summer";
    setBrowserUrl(`https://app.vm0.ai${path}#/verify?step=code`);

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
