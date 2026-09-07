import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { DesktopAuthSession } from "./desktop-auth-session";
import { resolveDesktopConfig } from "./config";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
} from "./desktop-auth";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";

const api = "https://api.vm0.ai";
const signedOut = { status: "signed_out", user: null, organization: null };
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSession(product: "okou" | "zero" = "okou") {
  const config = resolveDesktopConfig(undefined, product);
  const windows: DesktopAuthWindowRequest[] = [];
  const replies: Promise<string | null>[] = [];
  const completed: string[] = [];
  const changes: (string | null)[] = [];
  const cookiesRead: string[] = [];
  const session = new DesktopAuthSession({
    product,
    apiBaseUrl: api,
    cookieUrls: [config.webUrl, config.platformUrl],
    cookieSource: {
      cookies: {
        get: async ({ url }) => {
          cookiesRead.push(url);
          return [
            { name: "__session", value: "legacy-user" },
            { name: "preview", value: "access" },
          ];
        },
      },
    },
    addClientHeaders: createDesktopClientHeaderInjector({
      clientVersion: "0.46.28",
      product,
    }),
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async (request) => {
      windows.push(request);
      return await (replies.shift() ?? Promise.resolve(null));
    },
    onChange: () => {
      changes.push(session.getCachedToken());
    },
    onAuthCompleted: () => {
      completed.push("completed");
    },
  });
  return { session, windows, replies, completed, cookiesRead, changes };
}

function identityHandlers(
  options: { orgId?: string; observed?: string[] } = {},
) {
  server.use(
    http.get(`${api}/api/auth/me`, ({ request }) => {
      const token = request.headers.get("authorization");
      options.observed?.push(`me:${token}`);
      expect(request.headers.get("cookie")).toBeNull();
      return HttpResponse.json({
        userId: token,
        email: "app@example.test",
        orgId: "app-org",
      });
    }),
    http.get(`${api}/api/org`, ({ request }) => {
      const token = request.headers.get("authorization");
      options.observed?.push(`org:${token}`);
      expect(request.headers.get("cookie")).toBeNull();
      return HttpResponse.json({
        id: options.orgId ?? "app-org",
        name: "App workspace",
      });
    }),
  );
}

describe("Okou App session authority", () => {
  it("requires a fresh App token before any native request despite legacy cookie-only API success", async () => {
    const { session, windows, cookiesRead } = createSession();
    const requests: string[] = [];
    server.use(
      http.get(`${api}/*`, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({
          userId: "legacy-user",
          orgId: "legacy-org",
        });
      }),
    );
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(
      (
        await session.fetchWithSessionAuth(new URL(`${api}/api/protected`), {
          headers: {
            cookie: "__session=legacy",
            authorization: "Bearer injected",
          },
        })
      ).status,
    ).toBe(401);
    expect(requests).toEqual([]);
    expect(cookiesRead).toEqual([]);
    expect(windows.map((w) => w.url)).toEqual([
      "https://app.okou.ai/desktop-auth/token",
    ]);
  });

  it("restores matching user/org under one bearer and preserves native client headers", async () => {
    const { session, replies, cookiesRead } = createSession();
    const observed: string[] = [];
    identityHandlers({ observed });
    replies.push(Promise.resolve("fresh"));
    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "Bearer fresh", email: "app@example.test" },
      organization: { id: "app-org", name: "App workspace" },
    });
    server.use(
      http.post(`${api}/api/protected`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh");
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.credentials).toBe("omit");
        expect(request.redirect).toBe("error");
        expect(request.headers.get("x-client-type")).toBe("Desktop");
        expect(request.headers.get("x-client-version")).toBe("0.46.28");
        return HttpResponse.json(await request.json());
      }),
    );
    const response = await session.fetchWithSessionAuth(
      new URL(`${api}/api/protected`),
      {
        method: "POST",
        body: JSON.stringify({ action: "test" }),
        headers: { cookie: "legacy", authorization: "Bearer wrong" },
        credentials: "include",
        redirect: "follow",
      },
    );
    expect(await response.json()).toEqual({ action: "test" });
    expect(observed).toEqual(["me:Bearer fresh", "org:Bearer fresh"]);
    expect(cookiesRead).toEqual([]);
  });

  it("rejects mismatching bearer user/org responses before exposing a cached token", async () => {
    const { session, replies } = createSession();
    identityHandlers({ orgId: "other-org" });
    replies.push(Promise.resolve("fresh"));
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
  });

  it("does one bounded App refresh after 401 without a cookie-only retry", async () => {
    const { session, replies, windows } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("expired"), Promise.resolve("fresh"));
    await session.getToken();
    const tokens: (string | null)[] = [];
    server.use(
      http.get(`${api}/api/protected`, ({ request }) => {
        const token = request.headers.get("authorization");
        tokens.push(token);
        return new HttpResponse(null, {
          status: token === "Bearer fresh" ? 200 : 401,
        });
      }),
    );
    expect(
      (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
        .status,
    ).toBe(200);
    expect(tokens).toEqual(["Bearer expired", "Bearer fresh"]);
    expect(windows).toHaveLength(2);
  });

  it.each([null, "rejected"])(
    "clears rejected credentials when refresh delivers %s",
    async (refreshed) => {
      const { session, replies, windows } = createSession();
      identityHandlers();
      replies.push(Promise.resolve("expired"), Promise.resolve(refreshed));
      await session.getToken();
      let count = 0;
      server.use(
        http.get(`${api}/api/protected`, () => {
          count++;
          return new HttpResponse(null, { status: 401 });
        }),
      );
      expect(
        (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
          .status,
      ).toBe(401);
      expect(session.getCachedToken()).toBeNull();
      expect(count).toBe(refreshed ? 2 : 1);
      expect(windows).toHaveLength(2);
    },
  );

  it("notifies subscribers of a failed App refresh and waits for explicit sign-in", async () => {
    const { session, replies, windows, changes } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("expired"), Promise.resolve(null));
    await session.getToken();
    server.use(
      http.get(
        `${api}/api/protected`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    expect(
      (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
        .status,
    ).toBe(401);
    expect(changes).toEqual(["expired", null]);
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    expect(windows).toHaveLength(2);
    replies.push(Promise.resolve("explicit"));
    await session.consumeCode("new-code");
    expect(session.getCachedToken()).toBe("explicit");
    expect(windows).toHaveLength(3);
  });

  it("refreshes the entire identity pair when the organization read rejects the old token", async () => {
    const { session, replies } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("old"));
    await session.getToken();
    const observed: string[] = [];
    identityHandlers({ observed });
    server.use(
      http.get(`${api}/api/org`, ({ request }) => {
        const token = request.headers.get("authorization");
        observed.push(`org:${token}`);
        return token === "Bearer old"
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ id: "app-org", name: "new workspace" });
      }),
    );
    replies.push(Promise.resolve("new"));
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      user: { userId: "Bearer new" },
      organization: { name: "new workspace" },
    });
    expect(observed).toEqual([
      "me:Bearer old",
      "org:Bearer old",
      "me:Bearer new",
      "org:Bearer new",
    ]);
  });

  it("coalesces refreshes and recognizes a new delivery even if the token bytes are identical", async () => {
    const { session, replies, windows, completed } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const first = session.getToken();
    const second = session.getToken();
    reply.resolve("same");
    expect(await Promise.all([first, second])).toEqual(["same", "same"]);
    replies.push(Promise.resolve("same"));
    expect(await session.getToken({ forceRefresh: true })).toBe("same");
    expect(windows).toHaveLength(2);
    expect(completed).toEqual([]);
    replies.push(Promise.resolve(null));
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    expect(session.getCachedToken()).toBeNull();
  });

  it("invalidates a late refresh on sign-out and accepts only a subsequent explicit flow", async () => {
    const { session, replies, windows, completed } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const refresh = session.getToken();
    session.signOut();
    reply.resolve("late");
    expect(await refresh).toBeNull();
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    replies.push(Promise.resolve("explicit"));
    await session.consumeCode("new-code", "handoff-id");
    expect(session.getCachedToken()).toBe("explicit");
    expect(completed).toEqual(["completed"]);
    expect(windows[1]?.url).toBe(
      "https://app.okou.ai/desktop-auth/consume?code=new-code&handoffId=handoff-id",
    );
  });

  it("discards a superseded consume and keeps the latest organization operation", async () => {
    const { session, replies, windows, completed } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const old = session.consumeCode("old");
    const rejected = expect(old).rejects.toThrow();
    expect(await session.getAuthState()).toMatchObject({
      status: "signing_in",
    });
    replies.push(Promise.resolve("latest"));
    await session.selectOrganization();
    reply.resolve("late");
    await rejected;
    expect(session.getCachedToken()).toBe("latest");
    expect(completed).toEqual(["completed"]);
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(windows[1]?.url).toBe(
      "https://app.okou.ai/desktop-auth/select-org?force=true",
    );
  });

  it("cannot publish an identity whose delayed API validation outlives sign-out", async () => {
    const { session, replies, completed } = createSession();
    identityHandlers();
    const entered = deferred<void>();
    const reply = deferred<void>();
    server.use(
      http.get(`${api}/api/org`, async () => {
        entered.resolve();
        await reply.promise;
        return HttpResponse.json({ id: "app-org", name: "late" });
      }),
    );
    replies.push(Promise.resolve("late"));
    const consume = session.consumeCode("code");
    const rejected = expect(consume).rejects.toThrow();
    await entered.promise;
    session.signOut();
    reply.resolve();
    await rejected;
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
    expect(completed).toEqual([]);
  });

  it("keeps a new callback identity when it supersedes cold-start restoration", async () => {
    const { session, replies, windows } = createSession();
    identityHandlers();
    const old = deferred<string | null>();
    replies.push(old.promise);
    const restore = session.getToken();
    replies.push(Promise.resolve("callback-user"));
    await session.consumeCode("callback-code");
    old.resolve("old-user");
    expect(await restore).toBeNull();
    expect(session.getCachedToken()).toBe("callback-user");
    expect(windows[0]?.signal.aborted).toBe(true);
  });

  it("rejects a newly delivered bearer that the identity API no longer accepts", async () => {
    const { session, replies, completed } = createSession();
    server.use(
      http.get(
        `${api}/api/auth/me`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    replies.push(Promise.resolve("revoked"));
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
    expect(completed).toEqual([]);
  });

  it("does not leak a bearer to a non-API request origin", async () => {
    const { session, replies } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("fresh"));
    await expect(
      session.fetchWithSessionAuth(new URL("https://untrusted.test/api")),
    ).rejects.toThrow("Invalid Desktop API origin");
  });
});

describe("Zero compatibility", () => {
  it("retains cookie-only restoration and WWW auth routes", async () => {
    const { session, windows, cookiesRead, replies } = createSession("zero");
    server.use(
      http.get(`${api}/api/auth/me`, ({ request }) => {
        expect(request.headers.get("cookie")).toContain(
          "__session=legacy-user",
        );
        return HttpResponse.json({
          userId: "zero-user",
          email: "zero@example.test",
        });
      }),
      http.get(`${api}/api/org`, () =>
        HttpResponse.json({ id: "zero-org", name: "Zero" }),
      ),
    );
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      user: { userId: "zero-user" },
    });
    expect(windows).toHaveLength(0);
    expect(cookiesRead).toContain("https://www.vm0.ai/");
    replies.push(Promise.resolve("zero-token"));
    await session.selectOrganization();
    expect(windows[0]?.url).toBe(
      "https://www.vm0.ai/desktop-auth/select-org?force=true",
    );
    expect(session.getCachedToken()).toBe("zero-token");
  });

  it("retains Zero cookie retry after bearer rejection", async () => {
    const { session, replies } = createSession("zero");
    replies.push(Promise.resolve("zero-token"));
    await session.getToken();
    const tokens: (string | null)[] = [];
    server.use(
      http.get(`${api}/api/protected`, ({ request }) => {
        tokens.push(request.headers.get("authorization"));
        return new HttpResponse(null, {
          status: request.headers.has("authorization") ? 401 : 200,
        });
      }),
    );
    expect(
      (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
        .status,
    ).toBe(200);
    expect(tokens).toEqual(["Bearer zero-token", null]);
  });

  it("clears pending callbacks on sign-out", () => {
    const { session } = createSession("zero");
    session.queuePendingCallback({ code: "code", handoffId: null });
    expect(session.takePendingCallback()).toEqual({
      code: "code",
      handoffId: null,
    });
    expect(session.takePendingCallback()).toBeNull();
    session.queuePendingCallback({ code: "late", handoffId: null });
    session.signOut();
    expect(session.takePendingCallback()).toBeNull();
  });
});
