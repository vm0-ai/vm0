import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthSession } from "./desktop-auth-session";
import type { DesktopSessionCookieSource } from "./desktop-session-cookies";

const TOKEN_URL = "https://www.vm0.ai/desktop-auth/token";
const SELECT_ORG_URL = "https://www.vm0.ai/desktop-auth/select-org";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createSession() {
  const onChange = vi.fn();
  const onAuthCompleted = vi.fn(async () => {});
  const cookieSource: DesktopSessionCookieSource = {
    cookies: {
      async get() {
        return [];
      },
    },
  };
  const runAuthWindow = vi.fn(
    async (_request: {
      readonly url: string;
      readonly visible: boolean;
      readonly allowInteractiveFallbacks: boolean;
    }) => {},
  );
  const session = new DesktopAuthSession({
    apiBaseUrl: "https://api.vm0.ai",
    cookieUrls: [new URL("https://www.vm0.ai"), new URL("https://app.vm0.ai")],
    cookieSource,
    tokenUrl: TOKEN_URL,
    consumeUrl: (code) =>
      `https://www.vm0.ai/desktop-auth/consume?code=${code}`,
    selectOrgUrl: SELECT_ORG_URL,
    runAuthWindow,
    onChange,
    onAuthCompleted,
  });
  return { session, runAuthWindow, onChange, onAuthCompleted };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DesktopAuthSession", () => {
  it("returns the cached token without opening a window", async () => {
    const { session, runAuthWindow } = createSession();
    session.completeSignIn("cached");

    expect(await session.getToken()).toBe("cached");
    expect(runAuthWindow).not.toHaveBeenCalled();
  });

  it("exposes the cached token without refreshing", () => {
    const { session, runAuthWindow } = createSession();

    expect(session.getCachedToken()).toBeNull();
    session.completeSignIn("cached");

    expect(session.getCachedToken()).toBe("cached");
    expect(runAuthWindow).not.toHaveBeenCalled();
  });

  it("stores the token and fires onChange on completeSignIn", async () => {
    const { session, onChange } = createSession();

    session.completeSignIn("tok");

    expect(onChange).toHaveBeenCalledOnce();
    expect(await session.getToken()).toBe("tok");
  });

  it("returns the freshly delivered token on a forced refresh", async () => {
    const { session, runAuthWindow } = createSession();
    runAuthWindow.mockImplementation(async () => {
      session.completeSignIn("fresh");
    });

    const token = await session.getToken({ forceRefresh: true });

    expect(token).toBe("fresh");
    expect(runAuthWindow).toHaveBeenCalledWith({
      url: TOKEN_URL,
      visible: false,
      allowInteractiveFallbacks: false,
    });
  });

  it("returns null when the refresh window delivers no token (R3)", async () => {
    const { session, runAuthWindow } = createSession();
    // Window navigates to completion but never calls completeSignIn.
    runAuthWindow.mockImplementation(async () => {});

    const token = await session.getToken({ forceRefresh: true });

    expect(token).toBeNull();
    expect(runAuthWindow).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes and re-runs after settling", async () => {
    const { session, runAuthWindow } = createSession();
    let releaseWindow: () => void = () => {};
    runAuthWindow.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseWindow = resolve;
        }),
    );

    const first = session.getToken({ forceRefresh: true });
    const second = session.getToken({ forceRefresh: true });
    session.completeSignIn("fresh");
    releaseWindow();
    const [firstToken, secondToken] = await Promise.all([first, second]);

    expect(firstToken).toBe("fresh");
    expect(secondToken).toBe("fresh");
    expect(runAuthWindow).toHaveBeenCalledOnce();

    // The single-flight guard is cleared in `finally`, so a later refresh
    // opens a new window instead of reusing the settled promise.
    runAuthWindow.mockImplementation(async () => {
      session.completeSignIn("fresh-2");
    });
    expect(await session.getToken({ forceRefresh: true })).toBe("fresh-2");
    expect(runAuthWindow).toHaveBeenCalledTimes(2);
  });

  it("does not restart dependent runtimes after a background refresh", async () => {
    const { session, runAuthWindow, onAuthCompleted } = createSession();
    runAuthWindow.mockImplementation(async () => {
      session.completeSignIn("fresh");
    });

    await session.getToken({ forceRefresh: true });

    expect(onAuthCompleted).not.toHaveBeenCalled();
  });

  it("runs onAuthCompleted after a consume flow", async () => {
    const { session, runAuthWindow, onAuthCompleted } = createSession();

    await session.consumeCode("code-123");

    expect(runAuthWindow).toHaveBeenCalledWith({
      url: "https://www.vm0.ai/desktop-auth/consume?code=code-123",
      visible: false,
      allowInteractiveFallbacks: true,
    });
    expect(onAuthCompleted).toHaveBeenCalledOnce();
    expect(runAuthWindow.mock.invocationCallOrder[0]).toBeLessThan(
      onAuthCompleted.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("reports signing-in state while a consume flow is pending", async () => {
    const { session, runAuthWindow, onAuthCompleted } = createSession();
    let finishAuthWindow: () => void = () => {};
    runAuthWindow.mockImplementationOnce(() => {
      return new Promise<void>((resolve) => {
        finishAuthWindow = resolve;
      });
    });

    const consumePromise = session.consumeCode("code-123");

    expect(await session.getAuthState()).toEqual({
      status: "signing_in",
      user: null,
      organization: null,
    });

    session.completeSignIn("fresh");
    finishAuthWindow();
    await consumePromise;

    expect(onAuthCompleted).toHaveBeenCalledOnce();
  });

  it("clears signing-in state when a consume flow fails", async () => {
    const { session, runAuthWindow } = createSession();
    runAuthWindow
      .mockRejectedValueOnce(new Error("consume failed"))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    await expect(session.consumeCode("code-123")).rejects.toThrow(
      "consume failed",
    );

    expect(await session.getAuthState()).toEqual({
      status: "signed_out",
      user: null,
      organization: null,
    });
  });

  it("runs onAuthCompleted after a visible org-selection flow", async () => {
    const { session, runAuthWindow, onAuthCompleted } = createSession();

    await session.selectOrganization();

    expect(runAuthWindow).toHaveBeenCalledWith({
      url: SELECT_ORG_URL,
      visible: true,
      allowInteractiveFallbacks: true,
    });
    expect(onAuthCompleted).toHaveBeenCalledOnce();
  });

  it("derives signed-in state with an organization", async () => {
    const { session } = createSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/auth/me")) {
          return jsonResponse({ userId: "u1", email: "u@example.com" });
        }
        return jsonResponse({ id: "o1", name: "Org One", slug: "org-one" });
      }),
    );

    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "u1", email: "u@example.com" },
      organization: { id: "o1", name: "Org One", slug: "org-one" },
    });
  });

  it("retries auth state with cookies when the cached token is rejected", async () => {
    const { session } = createSession();
    const observedAuthorization: (string | null)[] = [];
    session.completeSignIn("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        observedAuthorization.push(headers.get("authorization"));
        const url = String(input);
        if (url.endsWith("/api/auth/me") && headers.has("authorization")) {
          return new Response(null, { status: 401 });
        }
        if (url.endsWith("/api/auth/me")) {
          return jsonResponse({ userId: "u1", email: "u@example.com" });
        }
        return jsonResponse({ id: "o1", name: "Org One", slug: "org-one" });
      }),
    );

    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "u1", email: "u@example.com" },
      organization: { id: "o1", name: "Org One", slug: "org-one" },
    });
    expect(observedAuthorization).toStrictEqual(["Bearer stale", null, null]);
    expect(session.getCachedToken()).toBeNull();
  });

  it("refreshes the desktop token and retries auth state after a 401", async () => {
    const { session, runAuthWindow } = createSession();
    const observedAuthorization: (string | null)[] = [];
    runAuthWindow.mockImplementation(async () => {
      session.completeSignIn("fresh");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        observedAuthorization.push(headers.get("authorization"));
        const url = String(input);
        if (
          url.endsWith("/api/auth/me") &&
          headers.get("authorization") === "Bearer fresh"
        ) {
          return jsonResponse({ userId: "u1", email: "u@example.com" });
        }
        if (url.endsWith("/api/auth/me")) {
          return new Response(null, { status: 401 });
        }
        return jsonResponse({ id: "o1", name: "Org One", slug: "org-one" });
      }),
    );

    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "u1", email: "u@example.com" },
      organization: { id: "o1", name: "Org One", slug: "org-one" },
    });
    expect(runAuthWindow).toHaveBeenCalledWith({
      url: TOKEN_URL,
      visible: false,
      allowInteractiveFallbacks: false,
    });
    expect(observedAuthorization).toStrictEqual([
      null,
      "Bearer fresh",
      "Bearer fresh",
    ]);
  });

  it("derives signed-in state with a null organization on 404", async () => {
    const { session } = createSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/api/auth/me")) {
          return jsonResponse({ userId: "u1", email: "u@example.com" });
        }
        return new Response(null, { status: 404 });
      }),
    );

    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "u1", email: "u@example.com" },
      organization: null,
    });
  });

  it("clears the cached token when auth state returns 401", async () => {
    const { session, runAuthWindow } = createSession();
    session.completeSignIn("stale");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const state = await session.getAuthState();

    expect(state).toEqual({
      status: "signed_out",
      user: null,
      organization: null,
    });
    // Auth-state checks now make one hidden refresh attempt before settling on
    // signed out.
    expect(runAuthWindow).toHaveBeenCalledOnce();
  });
});
