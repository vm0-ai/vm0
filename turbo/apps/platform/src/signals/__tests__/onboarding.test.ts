import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import { pathname$ } from "../route.ts";
import {
  needsOnboarding$,
  showOnboardingModal$,
  setOnboardingSecret$,
  setOnboardingProviderType$,
  setOnboardingAuthMethod$,
  setOnboardingSecretField$,
  saveOnboardingConfig$,
  closeOnboardingModal$,
} from "../onboarding.ts";
import { act } from "@testing-library/react";

const context = testContext();

describe("startOnboarding$", () => {
  it("visit an org protected page without an org will redirect to the onboarding page", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    await setupPage({
      context,
      path: "/logs",
      withoutRender: true,
    });

    expect(context.store.get(pathname$)).toBe("/");
  });
});

describe("needsOnboarding$", () => {
  it("should return true when no org exists", async () => {
    server.use(
      http.get("/api/scope", () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeTruthy();
  });

  it("should return true when no model providers exist", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeTruthy();
  });

  it("should return false when both org and a model provider exist", async () => {
    // Default mocks have both org and oauth token
    await setupPage({ context, path: "/", withoutRender: true });

    const needsOnboarding = await context.store.get(needsOnboarding$);
    expect(needsOnboarding).toBeFalsy();
  });
});

describe("saveOnboardingConfig$", () => {
  it("should create model provider when saving with oauth token", async () => {
    let providerCreated = false;

    server.use(
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

    await setupPage({ context, path: "/", withoutRender: true });

    act(() => {
      context.store.set(setOnboardingSecret$, "test-oauth-token");
    });

    await act(async () => {
      await context.store.set(saveOnboardingConfig$, context.signal);
    });

    expect(providerCreated).toBeTruthy();
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });

  it("should create model provider with api-key type", async () => {
    let createdBody: Record<string, unknown> | null = null;

    server.use(
      http.put("/api/model-providers", async ({ request }) => {
        createdBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "new-provider",
              type: "anthropic-api-key",
              framework: "claude-code",
              credentialName: "ANTHROPIC_API_KEY",
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

    await setupPage({ context, path: "/", withoutRender: true });

    act(() => {
      context.store.set(setOnboardingProviderType$, "anthropic-api-key");
    });

    act(() => {
      context.store.set(setOnboardingSecret$, "sk-ant-test-key");
    });

    await act(async () => {
      await context.store.set(saveOnboardingConfig$, context.signal);
    });

    expect(createdBody).toBeTruthy();
    expect(createdBody!.type).toBe("anthropic-api-key");
    expect(createdBody!.secret).toBe("sk-ant-test-key");
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });

  it("should create model provider with multi-auth type", async () => {
    let createdBody: Record<string, unknown> | null = null;

    server.use(
      http.put("/api/model-providers", async ({ request }) => {
        createdBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            provider: {
              id: "new-provider",
              type: "aws-bedrock",
              framework: "claude-code",
              credentialName: "AWS_BEARER_TOKEN_BEDROCK",
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

    await setupPage({ context, path: "/", withoutRender: true });

    act(() => {
      context.store.set(setOnboardingProviderType$, "aws-bedrock");
    });

    act(() => {
      context.store.set(setOnboardingAuthMethod$, "api-key");
    });

    act(() => {
      context.store.set(
        setOnboardingSecretField$,
        "AWS_BEARER_TOKEN_BEDROCK",
        "test-bedrock-key",
      );
    });

    act(() => {
      context.store.set(setOnboardingSecretField$, "AWS_REGION", "us-east-1");
    });

    await act(async () => {
      await context.store.set(saveOnboardingConfig$, context.signal);
    });

    expect(createdBody).toBeTruthy();
    expect(createdBody!.type).toBe("aws-bedrock");
    expect(createdBody!.authMethod).toBe("api-key");
    expect(createdBody!.secrets).toStrictEqual({
      AWS_BEARER_TOKEN_BEDROCK: "test-bedrock-key",
      AWS_REGION: "us-east-1",
    });
    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });

  it("should not save when secret is empty", async () => {
    let providerCreated = false;

    server.use(
      http.put("/api/model-providers", () => {
        providerCreated = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await act(async () => {
      await context.store.set(saveOnboardingConfig$, context.signal);
    });

    expect(providerCreated).toBeFalsy();
  });
});

describe("closeOnboardingModal$", () => {
  it("should close modal and reset form", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    act(() => {
      context.store.set(closeOnboardingModal$);
    });

    expect(context.store.get(showOnboardingModal$)).toBeFalsy();
  });
});
