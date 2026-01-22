import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/helper.ts";
import { pathname$ } from "../route.ts";

const context = testContext();

describe("startOnboarding$", () => {
  it("visit a scope protected page without a scope will redirect to the onboarding page", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
    });

    expect(context.store.get(pathname$)).toBe("/");
  });
});
