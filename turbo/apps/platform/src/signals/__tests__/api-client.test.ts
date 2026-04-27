import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { zeroClient$ } from "../api-client.ts";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { testContext } from "./test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";
import { createMockApi } from "../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("zeroClient$ 401 redirect", () => {
  it("should redirect to sign-in when API returns 401", async () => {
    server.use(
      mockApi(zeroOrgContract.get, ({ respond }) => {
        return respond(401, {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        });
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
  });

  it("should not redirect on non-401 errors", async () => {
    detachedSetupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    server.use(
      // mockApi cannot be used here: 403 is not declared in zeroOrgContract.get responses,
      // so this raw handler is the only way to simulate a forbidden response for this test.
      http.get("*/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Forbidden", code: "FORBIDDEN" } },
          { status: 403 },
        );
      }),
    );

    mockedClerk.redirectToSignIn.mockClear();

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(403);
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("refreshes the token and retries once on 401, returning success", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        if (authHeaders.length === 1) {
          return respond(401, {
            error: { message: "Unauthorized", code: "UNAUTHORIZED" },
          });
        }
        return respond(200, {
          id: "org_1",
          name: "Org",
          slug: "org-1",
          role: "admin",
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(200);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.sessionGetToken).toHaveBeenCalledWith({
      skipCache: true,
    });
    expect(mockedClerk.redirectToSignIn).not.toHaveBeenCalled();
  });

  it("redirects when retry also returns 401", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? "fresh-token" : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual([
      "Bearer stale-token",
      "Bearer fresh-token",
    ]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("skips retry and redirects when the refreshed token is null", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "stale-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockImplementation((opts) => {
      return Promise.resolve(opts?.skipCache ? null : "stale-token");
    });

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer stale-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });

  it("skips retry when the refreshed token equals the initial token", async () => {
    detachedSetupPage({
      context,
      path: "/",
      session: { token: "same-token" },
      withoutRender: true,
    });

    mockedClerk.redirectToSignIn.mockClear();
    mockedClerk.sessionGetToken.mockReset();
    mockedClerk.sessionGetToken.mockResolvedValue("same-token");

    const authHeaders: string[] = [];
    server.use(
      mockApi(zeroOrgContract.get, ({ request, respond }) => {
        authHeaders.push(request.headers.get("authorization") ?? "");
        return respond(401, {
          error: { message: "Unauthorized", code: "UNAUTHORIZED" },
        });
      }),
    );

    const createClient = context.store.get(zeroClient$);
    const client = createClient(zeroOrgContract);
    const result = await client.get();

    expect(result.status).toBe(401);
    expect(authHeaders).toStrictEqual(["Bearer same-token"]);
    expect(mockedClerk.redirectToSignIn).toHaveBeenCalledTimes(1);
  });
});
