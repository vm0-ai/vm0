// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DesktopAuthCallbackClient } from "../DesktopAuthCallbackClient";

interface ClerkAuthState {
  readonly getToken: () => Promise<string | null>;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean;
}

const clerkState = vi.hoisted(() => {
  return {
    auth: {
      getToken: vi.fn<() => Promise<string | null>>(),
      isLoaded: true,
      isSignedIn: true,
    } as ClerkAuthState,
    searchParams: new URLSearchParams(),
  };
});

vi.mock("@clerk/nextjs", () => {
  return {
    useAuth: () => {
      return clerkState.auth;
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

const fetchMock = vi.fn<typeof fetch>();

describe("DesktopAuthCallbackClient", () => {
  beforeEach(() => {
    const getToken = vi.fn<() => Promise<string | null>>();
    getToken.mockResolvedValue("browser-session-token");
    clerkState.auth = {
      getToken,
      isLoaded: true,
      isSignedIn: true,
    };
    clerkState.searchParams = new URLSearchParams();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/desktop-auth/callback");
  });

  it("creates a desktop handoff and navigates to the callback URL", async () => {
    const callbackUrl =
      "ai.vm0.zero.desktop://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ callbackUrl }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<DesktopAuthCallbackClient />);

    expect(screen.getByText("Signing in...")).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/desktop-auth/handoff", {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-session-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    });
    await waitFor(() => {
      expect(window.location.href).toBe(callbackUrl);
    });
  });

  it("preserves the requested desktop callback scheme", async () => {
    const callbackUrl =
      "ai.vm0.zero.desktop.dev://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";
    clerkState.searchParams = new URLSearchParams({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ callbackUrl }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<DesktopAuthCallbackClient />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/desktop-auth/handoff", {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-session-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          callbackScheme: "ai.vm0.zero.desktop.dev",
        }),
      });
    });
  });

  it("redirects signed-out sessions back to the desktop auth start page", async () => {
    clerkState.auth = {
      getToken: vi.fn<() => Promise<string | null>>(),
      isLoaded: true,
      isSignedIn: false,
    };
    clerkState.searchParams = new URLSearchParams({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });
    const replace = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {
        return undefined;
      });

    render(<DesktopAuthCallbackClient />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/desktop-auth/start?callbackScheme=ai.vm0.zero.desktop.dev",
      );
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
