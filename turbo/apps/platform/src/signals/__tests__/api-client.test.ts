import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { zeroClient$ } from "../api-client.ts";
import { zeroOrgContract } from "@vm0/core";
import { testContext } from "./test-helpers.ts";
import { detachedSetupPage } from "../../__tests__/page-helper.ts";
import { mockedClerk } from "../../__tests__/mock-auth.ts";

const context = testContext();

describe("zeroClient$ 401 redirect", () => {
  it("should redirect to sign-in when API returns 401", async () => {
    server.use(
      http.get("http://localhost:3000/api/zero/org", () => {
        return HttpResponse.json(
          { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
          { status: 401 },
        );
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
      http.get("http://localhost:3000/api/zero/org", () => {
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
});
