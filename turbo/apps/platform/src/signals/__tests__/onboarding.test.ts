import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { scope$, hasScope$, type Scope } from "../scope.ts";
import {
  showOnboardingModal$,
  startOnboarding$,
  closeOnboardingModal$,
} from "../onboarding.ts";

// Mock environment variables BEFORE any module imports
vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Mock clerk-js (gets hoisted by vitest)
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return {
      user: {
        id: "test-user-123",
        fullName: "Test User",
      },
      session: {
        getToken: () => Promise.resolve("mock-token"),
      },
      load: () => Promise.resolve(),
      addListener: () => () => {},
    };
  },
}));

const context = testContext();

describe("onboarding flow", () => {
  describe("scope signals", () => {
    it("hasScope$ returns true when user has scope", async () => {
      // Default mock returns a scope
      const hasScope = await context.store.get(hasScope$);
      expect(hasScope).toBeTruthy();
    });

    it("hasScope$ returns false when user has no scope (404)", async () => {
      // Override handler to return 404
      server.use(
        http.get("/api/scope", () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const hasScope = await context.store.get(hasScope$);
      expect(hasScope).toBeFalsy();
    });

    it("scope$ returns scope data when available", async () => {
      const scope = await context.store.get(scope$);
      expect(scope).toBeDefined();
      expect(scope?.slug).toBe("user-12345678");
    });

    it("scope$ returns undefined when no scope (404)", async () => {
      server.use(
        http.get("/api/scope", () => {
          return new HttpResponse(null, { status: 404 });
        }),
      );

      const scope = await context.store.get(scope$);
      expect(scope).toBeUndefined();
    });
  });

  describe("onboarding modal signals", () => {
    it("showOnboardingModal$ is false by default", () => {
      const isOpen = context.store.get(showOnboardingModal$);
      expect(isOpen).toBeFalsy();
    });

    it("closeOnboardingModal$ sets modal to closed", () => {
      context.store.set(closeOnboardingModal$);
      const isOpen = context.store.get(showOnboardingModal$);
      expect(isOpen).toBeFalsy();
    });
  });

  describe("startOnboarding$", () => {
    it("shows modal and creates scope", async () => {
      const createdScopes: Scope[] = [];

      // Mock no scope initially, then return scope after creation
      server.use(
        http.get("/api/scope", () => {
          if (createdScopes.length === 0) {
            return new HttpResponse(null, { status: 404 });
          }
          return HttpResponse.json(createdScopes[0]);
        }),
        http.post("/api/scope", async ({ request }) => {
          const body = (await request.json()) as { slug: string };
          const newScope: Scope = {
            id: "scope_new",
            slug: body.slug,
            type: "personal",
            displayName: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          createdScopes.push(newScope);
          return HttpResponse.json(newScope, { status: 201 });
        }),
      );

      // Verify no scope initially
      const hasScopeBefore = await context.store.get(hasScope$);
      expect(hasScopeBefore).toBeFalsy();

      // Start onboarding
      await context.store.set(startOnboarding$, context.signal);

      // Modal should be shown
      const isModalOpen = context.store.get(showOnboardingModal$);
      expect(isModalOpen).toBeTruthy();

      // Scope should now exist
      const hasScopeAfter = await context.store.get(hasScope$);
      expect(hasScopeAfter).toBeTruthy();

      // Close modal
      context.store.set(closeOnboardingModal$);
      expect(context.store.get(showOnboardingModal$)).toBeFalsy();
    });
  });
});
