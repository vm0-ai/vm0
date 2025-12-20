/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  validateScopeSlug,
  getScopeBySlug,
  getScopeById,
  createScope,
  createUserScope,
  getUserScopeByClerkId,
} from "../scope-service";
import { initServices } from "../../init-services";
import { scopes } from "../../../db/schema/scope";
import { eq } from "drizzle-orm";
import { BadRequestError } from "../../errors";

describe("Scope Service", () => {
  describe("validateScopeSlug", () => {
    it("should accept valid slugs", () => {
      expect(() => validateScopeSlug("myslug")).not.toThrow();
      expect(() => validateScopeSlug("my-slug")).not.toThrow();
      expect(() => validateScopeSlug("my-long-slug-123")).not.toThrow();
      expect(() => validateScopeSlug("abc")).not.toThrow();
      expect(() => validateScopeSlug("a1b2c3")).not.toThrow();
    });

    it("should reject slugs that are too short", () => {
      expect(() => validateScopeSlug("ab")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("a")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("")).toThrow(BadRequestError);
    });

    it("should reject slugs that are too long", () => {
      const longSlug = "a".repeat(65);
      expect(() => validateScopeSlug(longSlug)).toThrow(BadRequestError);
    });

    it("should reject slugs with uppercase letters", () => {
      expect(() => validateScopeSlug("MySlug")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("MYSLUG")).toThrow(BadRequestError);
    });

    it("should reject slugs with invalid characters", () => {
      expect(() => validateScopeSlug("my_slug")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("my.slug")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("my slug")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("my@slug")).toThrow(BadRequestError);
    });

    it("should reject slugs starting with hyphen", () => {
      expect(() => validateScopeSlug("-myslug")).toThrow(BadRequestError);
    });

    it("should reject slugs ending with hyphen", () => {
      expect(() => validateScopeSlug("myslug-")).toThrow(BadRequestError);
    });

    it("should reject reserved slugs", () => {
      expect(() => validateScopeSlug("vm0")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("system")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("admin")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("api")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("app")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("www")).toThrow(BadRequestError);
    });

    it("should reject slugs starting with vm0", () => {
      expect(() => validateScopeSlug("vm0test")).toThrow(BadRequestError);
      expect(() => validateScopeSlug("vm0-custom")).toThrow(BadRequestError);
    });
  });

  describe("Database Operations", () => {
    const testUserId = "test-scope-service-user";
    const testSlug = `test-scope-${Date.now()}`;

    beforeAll(() => {
      initServices();
    });

    afterAll(async () => {
      // Cleanup test scopes
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.ownerId, testUserId));
    });

    describe("createScope", () => {
      it("should create a scope successfully", async () => {
        const scope = await createScope(
          testSlug,
          "personal",
          testUserId,
          "Test Scope",
        );

        expect(scope).toBeDefined();
        expect(scope.slug).toBe(testSlug);
        expect(scope.type).toBe("personal");
        expect(scope.ownerId).toBe(testUserId);
        expect(scope.displayName).toBe("Test Scope");
        expect(scope.id).toBeDefined();
      });

      it("should reject duplicate slugs", async () => {
        await expect(
          createScope(`${testSlug}-dup`, "personal", testUserId),
        ).resolves.toBeDefined();

        await expect(
          createScope(`${testSlug}-dup`, "personal", testUserId),
        ).rejects.toThrow("already exists");
      });
    });

    describe("getScopeBySlug", () => {
      it("should return scope when found", async () => {
        const slug = `test-get-${Date.now()}`;
        await createScope(slug, "personal", testUserId);

        const scope = await getScopeBySlug(slug);
        expect(scope).toBeDefined();
        expect(scope!.slug).toBe(slug);
      });

      it("should return null when not found", async () => {
        const scope = await getScopeBySlug("nonexistent-scope-12345");
        expect(scope).toBeNull();
      });
    });

    describe("getScopeById", () => {
      it("should return scope when found", async () => {
        const slug = `test-getid-${Date.now()}`;
        const created = await createScope(slug, "personal", testUserId);

        const scope = await getScopeById(created.id);
        expect(scope).toBeDefined();
        expect(scope!.id).toBe(created.id);
      });

      it("should return null when not found", async () => {
        const scope = await getScopeById(
          "00000000-0000-0000-0000-000000000000",
        );
        expect(scope).toBeNull();
      });
    });

    describe("getUserScopeByClerkId", () => {
      it("should return user's personal scope", async () => {
        const userId = `test-user-${Date.now()}`;
        const slug = `user-scope-${Date.now()}`;
        await createScope(slug, "personal", userId);

        const scope = await getUserScopeByClerkId(userId);
        expect(scope).toBeDefined();
        expect(scope!.ownerId).toBe(userId);
        expect(scope!.type).toBe("personal");
      });

      it("should return null if user has no scope", async () => {
        const scope = await getUserScopeByClerkId("nonexistent-user-12345");
        expect(scope).toBeNull();
      });
    });

    describe("createUserScope", () => {
      it("should create personal scope for user", async () => {
        const userId = `test-create-user-${Date.now()}`;
        const slug = `user-create-${Date.now()}`;

        const scope = await createUserScope(userId, slug, "My Personal Scope");

        expect(scope).toBeDefined();
        expect(scope.slug).toBe(slug);
        expect(scope.type).toBe("personal");
        expect(scope.ownerId).toBe(userId);
        expect(scope.displayName).toBe("My Personal Scope");
      });

      it("should reject if user already has a scope", async () => {
        const userId = `test-duplicate-user-${Date.now()}`;
        const slug1 = `user-dup1-${Date.now()}`;
        const slug2 = `user-dup2-${Date.now()}`;

        await createUserScope(userId, slug1);

        await expect(createUserScope(userId, slug2)).rejects.toThrow(
          "already have a scope",
        );
      });
    });
  });
});
