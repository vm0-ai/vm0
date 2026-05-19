// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../../../components/ThemeProvider";
import { DesktopAuthStartClient } from "../DesktopAuthStartClient";

const clerkState = vi.hoisted(() => {
  return {
    auth: { isLoaded: true, isSignedIn: false },
    signInProps: null as Record<string, unknown> | null,
    searchParams: new URLSearchParams(),
  };
});

vi.mock("@clerk/nextjs", () => {
  return {
    useAuth: () => {
      return clerkState.auth;
    },
    SignIn: (props: Record<string, unknown>) => {
      clerkState.signInProps = props;
      return <div data-testid="desktop-sign-in" />;
    },
  };
});

vi.mock("next/navigation", () => {
  return {
    useSearchParams: () => {
      return clerkState.searchParams;
    },
  };
});

vi.mock("next/link", () => {
  return {
    default: ({
      href,
      children,
      className,
      ...props
    }: {
      href: string;
      children?: ReactNode;
      className?: string;
    } & AnchorHTMLAttributes<HTMLAnchorElement>) => {
      return (
        <a href={href} className={className} {...props}>
          {children}
        </a>
      );
    },
  };
});

vi.mock("next/image", () => {
  return {
    default: ({ alt, src }: { alt: string; src: string }) => {
      return <span data-alt={alt} data-src={src} />;
    },
  };
});

function mockMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => {
      return {
        matches: query === "(prefers-color-scheme: dark)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    },
    configurable: true,
  });
}

function renderStartClient() {
  return render(
    <ThemeProvider>
      <DesktopAuthStartClient />
    </ThemeProvider>,
  );
}

describe("DesktopAuthStartClient", () => {
  beforeEach(() => {
    clerkState.auth = { isLoaded: true, isSignedIn: false };
    clerkState.signInProps = null;
    clerkState.searchParams = new URLSearchParams();
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    mockMatchMedia();
  });

  it("renders Clerk sign-in with desktop callback redirects for signed-out users", () => {
    renderStartClient();

    expect(screen.getByTestId("desktop-sign-in")).toBeTruthy();
    expect(clerkState.signInProps).toMatchObject({
      fallbackRedirectUrl: "/desktop-auth/callback",
      forceRedirectUrl: "/desktop-auth/callback",
      oauthFlow: "redirect",
      path: "/desktop-auth/start",
      routing: "path",
      signUpFallbackRedirectUrl: "/desktop-auth/callback",
      signUpForceRedirectUrl: "/desktop-auth/callback",
    });
  });

  it("preserves the callback scheme in Clerk redirects", () => {
    clerkState.searchParams = new URLSearchParams({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });

    renderStartClient();

    expect(clerkState.signInProps).toMatchObject({
      fallbackRedirectUrl:
        "/desktop-auth/callback?callbackScheme=ai.vm0.zero.desktop.dev",
      forceRedirectUrl:
        "/desktop-auth/callback?callbackScheme=ai.vm0.zero.desktop.dev",
      signUpFallbackRedirectUrl:
        "/desktop-auth/callback?callbackScheme=ai.vm0.zero.desktop.dev",
      signUpForceRedirectUrl:
        "/desktop-auth/callback?callbackScheme=ai.vm0.zero.desktop.dev",
    });
  });

  it("redirects already signed-in browser sessions to the desktop callback", async () => {
    clerkState.auth = { isLoaded: true, isSignedIn: true };
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    renderStartClient();

    expect(screen.getByText("Signing in...")).toBeTruthy();
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/desktop-auth/callback");
    });
  });

  it("preserves the callback scheme when redirecting signed-in sessions", async () => {
    clerkState.auth = { isLoaded: true, isSignedIn: true };
    clerkState.searchParams = new URLSearchParams({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    renderStartClient();

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/desktop-auth/callback?callbackScheme=ai.vm0.zero.desktop.dev",
      );
    });
  });
});
