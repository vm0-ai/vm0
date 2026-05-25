// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { DesktopAuthConsumeClient } from "../DesktopAuthConsumeClient";

interface SignInResult {
  readonly createdSessionId: string | null;
  readonly status: string;
}

interface UseSignInState {
  readonly isLoaded: boolean;
  readonly setActive: (args: { readonly session: string }) => Promise<void>;
  readonly signIn: {
    readonly create: (args: {
      readonly strategy: "ticket";
      readonly ticket: string;
    }) => Promise<SignInResult>;
  };
}

const clerkState = vi.hoisted(() => {
  return {
    signIn: {
      isLoaded: true,
      setActive: vi.fn<(args: { readonly session: string }) => Promise<void>>(),
      signIn: {
        create:
          vi.fn<
            (args: {
              readonly strategy: "ticket";
              readonly ticket: string;
            }) => Promise<SignInResult>
          >(),
      },
    } as UseSignInState,
  };
});

vi.mock("@clerk/nextjs/legacy", () => {
  return {
    useSignIn: () => {
      return clerkState.signIn;
    },
  };
});

const fetchMock = vi.fn<typeof fetch>();

describe("DesktopAuthConsumeClient", () => {
  beforeEach(() => {
    const create =
      vi.fn<
        (args: {
          readonly strategy: "ticket";
          readonly ticket: string;
        }) => Promise<SignInResult>
      >();
    create.mockResolvedValue({
      createdSessionId: "session_desktop",
      status: "complete",
    });
    const setActive =
      vi.fn<(args: { readonly session: string }) => Promise<void>>();
    setActive.mockResolvedValue(undefined);
    clerkState.signIn = {
      isLoaded: true,
      setActive,
      signIn: { create },
    };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ token: "ticket_desktop" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(
      null,
      "",
      "/desktop-auth/consume?code=desktop-code",
    );
  });

  it("exchanges the desktop auth code and activates the Clerk session", async () => {
    render(<DesktopAuthConsumeClient code="desktop-code" />);

    expect(screen.getByText("Signing in...")).toBeTruthy();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/desktop-auth/consume", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ code: "desktop-code" }),
      });
    });
    await waitFor(() => {
      expect(clerkState.signIn.signIn.create).toHaveBeenCalledWith({
        strategy: "ticket",
        ticket: "ticket_desktop",
      });
    });
    await waitFor(() => {
      expect(clerkState.signIn.setActive).toHaveBeenCalledWith({
        session: "session_desktop",
      });
    });
    expect(window.location.pathname).toBe("/");
  });

  it("renders the provided error instead of consuming a code", () => {
    render(
      <DesktopAuthConsumeClient
        code="desktop-code"
        errorMessage="Missing desktop sign-in code."
      />,
    );

    expect(
      screen.getByText("Error: Missing desktop sign-in code."),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
