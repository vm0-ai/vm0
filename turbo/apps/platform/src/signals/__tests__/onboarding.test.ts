import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/helper.ts";
import { pathname$ } from "../route.ts";
import {
  needsOnboarding$,
  showOnboardingModal$,
  setTokenValue$,
  saveOnboardingConfig$,
  closeOnboardingModal$,
  startOnboarding$,
} from "../onboarding.ts";

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

describe("needsOnboarding$", () => {
  it("should return true when no scope exists", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    await setupPage({ context, path: "/" });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeTruthy();
  });

  it("should return true when no claude-code-oauth-token exists", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({ context, path: "/" });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeTruthy();
  });

  it("should return false when both scope and oauth token exist", async () => {
    // Default mocks have both scope and oauth token
    await setupPage({ context, path: "/" });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeFalsy();
  });
});

describe("saveOnboardingConfig$", () => {
  it("should create scope and model provider when saving", async () => {
    let scopeCreated = false;
    let providerCreated = false;

    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        scopeCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
      http.put("/api/model-providers", () => {
        providerCreated = true;
        return HttpResponse.json(
          {
            provider: {
              id: "new-provider",
              type: "claude-code-oauth-token",
              framework: "claude-code",
              credentialName: "CLAUDE_CODE_OAUTH_TOKEN",
              isDefault: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            created: true,
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/" });

    // Set token value and save
    context.store.set(startOnboarding$);
    context.store.set(setTokenValue$, "test-oauth-token");
    await context.store.set(saveOnboardingConfig$, context.signal);

    expect(scopeCreated).toBeTruthy();
    expect(providerCreated).toBeTruthy();
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });

  it("should not save when token is empty", async () => {
    let providerCreated = false;

    server.use(
      http.put("/api/model-providers", () => {
        providerCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({ context, path: "/" });

    // Try to save without setting token
    context.store.set(startOnboarding$);
    await context.store.set(saveOnboardingConfig$, context.signal);

    expect(providerCreated).toBeFalsy();
  });
});

describe("closeOnboardingModal$", () => {
  it("should create scope when closing without saving", async () => {
    let scopeCreated = false;
    let providerCreated = false;

    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.post("/api/scope", () => {
        scopeCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
      http.put("/api/model-providers", () => {
        providerCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({ context, path: "/" });

    context.store.set(startOnboarding$);
    await context.store.set(closeOnboardingModal$, context.signal);

    expect(scopeCreated).toBeTruthy();
    expect(providerCreated).toBeFalsy();
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });

  it("should not create scope if it already exists", async () => {
    let scopeCreated = false;

    server.use(
      http.post("/api/scope", () => {
        scopeCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    // Default mock has scope
    await setupPage({ context, path: "/" });

    context.store.set(startOnboarding$);
    await context.store.set(closeOnboardingModal$, context.signal);

    expect(scopeCreated).toBeFalsy();
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });
});
