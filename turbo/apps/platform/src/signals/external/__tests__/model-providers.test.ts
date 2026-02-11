import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server";
import { testContext } from "../../__tests__/test-helpers";
import { setupPage } from "../../../__tests__/page-helper";
import {
  modelProviders$,
  hasClaudeCodeOAuthToken$,
  reloadModelProviders$,
  createModelProvider$,
} from "../model-providers";

const context = testContext();
describe("test model providers", () => {
  it("should get correct result from msw", async () => {
    await setupPage({
      context,
      path: "/",
      withoutRender: true,
    });

    await expect(context.store.get(modelProviders$)).resolves.toHaveProperty(
      "modelProviders",
      [expect.objectContaining({ id: "dummy-provider" })],
    );
  });

  describe("hasClaudeCodeOAuthToken$", () => {
    it("should return true when claude-code-oauth-token provider exists", async () => {
      await setupPage({ context, path: "/", withoutRender: true });

      const hasToken = await context.store.get(hasClaudeCodeOAuthToken$);
      expect(hasToken).toBeTruthy();
    });

    it("should return false when no claude-code-oauth-token provider exists", async () => {
      server.use(
        http.get("/api/model-providers", () => {
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const hasToken = await context.store.get(hasClaudeCodeOAuthToken$);
      expect(hasToken).toBeFalsy();
    });

    it("should return false when only other provider types exist", async () => {
      server.use(
        http.get("/api/model-providers", () => {
          return HttpResponse.json({
            modelProviders: [
              {
                id: "anthropic-provider",
                type: "anthropic-api-key",
                framework: "claude-code",
                secretName: "ANTHROPIC_API_KEY",
                isDefault: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      const hasToken = await context.store.get(hasClaudeCodeOAuthToken$);
      expect(hasToken).toBeFalsy();
    });
  });

  describe("reloadModelProviders$", () => {
    it("should trigger reload of model providers", async () => {
      let callCount = 0;
      server.use(
        http.get("/api/model-providers", () => {
          callCount++;
          return HttpResponse.json({ modelProviders: [] });
        }),
      );

      await setupPage({ context, path: "/", withoutRender: true });

      // First fetch
      await context.store.get(modelProviders$);
      expect(callCount).toBe(1);

      // Trigger reload
      context.store.set(reloadModelProviders$);
      await context.store.get(modelProviders$);
      expect(callCount).toBe(2);
    });
  });

  describe("createModelProvider$", () => {
    it("should create a new model provider and trigger reload", async () => {
      let putCalled = false;
      server.use(
        http.put("/api/model-providers", async ({ request }) => {
          putCalled = true;
          const body = (await request.json()) as {
            type: string;
            secret: string;
          };
          return HttpResponse.json(
            {
              provider: {
                id: "new-provider",
                type: body.type,
                framework: "claude-code",
                secretName: "CLAUDE_CODE_OAUTH_TOKEN",
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

      await context.store.set(createModelProvider$, {
        type: "claude-code-oauth-token",
        secret: "test-token",
      });

      expect(putCalled).toBeTruthy();
    });
  });
});
