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

vi.mock("next/image", () => {
  return {
    default: ({ alt, src }: { alt: string; src: string }) => {
      return <span data-alt={alt} data-src={src} />;
    },
  };
});

const fetchMock = vi.fn<typeof fetch>();
const handoffId = "550e8400-e29b-41d4-a716-446655440000";

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
    const callbackUrl = `ai.vm0.zero.desktop://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-&handoffId=${handoffId}`;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ callbackUrl, handoffId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

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
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/desktop-auth/handoff/${handoffId}`,
        {
          headers: {
            Authorization: "Bearer browser-session-token",
          },
        },
      );
    });
    expect(screen.getByText("Waiting for Zero Computer Use")).toBeTruthy();
  });

  it("renders success after the desktop handoff is completed", async () => {
    const callbackUrl = `ai.vm0.zero.desktop://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-&handoffId=${handoffId}`;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ callbackUrl, handoffId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "completed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(<DesktopAuthCallbackClient />);

    await waitFor(() => {
      expect(screen.getByText("Zero Computer Use is signed in.")).toBeTruthy();
    });
    expect(
      screen.getByText(
        "You can close this browser window and return to the app.",
      ),
    ).toBeTruthy();
  });

  it("preserves the requested desktop callback scheme", async () => {
    const callbackUrl = `ai.vm0.zero.desktop.dev://auth/callback?code=abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-&handoffId=${handoffId}`;
    clerkState.searchParams = new URLSearchParams({
      callbackScheme: "ai.vm0.zero.desktop.dev",
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ callbackUrl, handoffId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => {}));

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
