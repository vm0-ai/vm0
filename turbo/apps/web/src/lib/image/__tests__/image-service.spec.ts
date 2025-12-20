/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  generateE2bAlias,
  isSystemTemplate,
  resolveImageAlias,
  getImageByScopeAndAlias,
} from "../image-service";
import { initServices } from "../../init-services";
import { createUserScope } from "../../scope/scope-service";
import { images } from "../../../db/schema/image";
import { scopes } from "../../../db/schema/scope";
import { eq } from "drizzle-orm";

describe("Image Service", () => {
  describe("generateE2bAlias", () => {
    it("should generate E2B alias with user prefix", () => {
      const alias = generateE2bAlias("user123", "my-agent");
      expect(alias).toBe("user-user123-my-agent");
    });

    it("should handle different user IDs", () => {
      const alias1 = generateE2bAlias("abc", "test");
      const alias2 = generateE2bAlias("xyz", "test");
      expect(alias1).toBe("user-abc-test");
      expect(alias2).toBe("user-xyz-test");
    });

    it("should handle special characters in user ID", () => {
      const alias = generateE2bAlias("user_abc-123", "my-image");
      expect(alias).toBe("user-user_abc-123-my-image");
    });
  });

  describe("isSystemTemplate", () => {
    it("should return true for vm0- prefixed templates", () => {
      expect(isSystemTemplate("vm0-claude-code")).toBe(true);
      expect(isSystemTemplate("vm0-base")).toBe(true);
      expect(isSystemTemplate("vm0-")).toBe(true);
    });

    it("should return false for user templates", () => {
      expect(isSystemTemplate("my-agent")).toBe(false);
      expect(isSystemTemplate("user-abc-test")).toBe(false);
      expect(isSystemTemplate("custom-template")).toBe(false);
    });

    it("should return false for templates that contain but don't start with vm0-", () => {
      expect(isSystemTemplate("my-vm0-agent")).toBe(false);
      expect(isSystemTemplate("test-vm0-")).toBe(false);
    });

    it("should be case sensitive", () => {
      expect(isSystemTemplate("VM0-test")).toBe(false);
      expect(isSystemTemplate("Vm0-test")).toBe(false);
    });
  });

  describe("resolveImageAlias with @scope/name", () => {
    const testUserId = "test-image-resolve-user";
    const testScopeSlug = `img-test-${Date.now()}`;
    let testScopeId: string;

    beforeAll(async () => {
      initServices();

      // Create test scope for the user
      const scope = await createUserScope(testUserId, testScopeSlug);
      testScopeId = scope.id;

      // Create a test image with scopeId
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "test-image",
        e2bAlias: `user-${testUserId}-test-image`,
        e2bTemplateId: "test-template-id",
        e2bBuildId: "test-build-id",
        status: "ready",
      });

      // Create a building image
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "building-image",
        e2bAlias: `user-${testUserId}-building-image`,
        e2bTemplateId: "build-template-id",
        e2bBuildId: "build-build-id",
        status: "building",
      });
    });

    afterAll(async () => {
      // Cleanup test data
      await globalThis.services.db
        .delete(images)
        .where(eq(images.userId, testUserId));
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.ownerId, testUserId));
    });

    it("should resolve @scope/name format to e2bAlias", async () => {
      const result = await resolveImageAlias(
        testUserId,
        `@${testScopeSlug}/test-image`,
      );
      expect(result.templateName).toBe(`user-${testUserId}-test-image`);
      expect(result.isUserImage).toBe(true);
    });

    it("should throw NotFoundError for non-existent scope", async () => {
      await expect(
        resolveImageAlias(testUserId, "@nonexistent-scope/test-image"),
      ).rejects.toThrow('Scope "@nonexistent-scope" not found');
    });

    it("should throw NotFoundError for non-existent image in scope", async () => {
      await expect(
        resolveImageAlias(testUserId, `@${testScopeSlug}/nonexistent`),
      ).rejects.toThrow(`not found`);
    });

    it("should throw BadRequestError for image not ready", async () => {
      await expect(
        resolveImageAlias(testUserId, `@${testScopeSlug}/building-image`),
      ).rejects.toThrow("not ready");
    });

    it("should pass through vm0- prefixed system templates", async () => {
      const result = await resolveImageAlias(testUserId, "vm0-claude-code");
      expect(result.templateName).toBe("vm0-claude-code");
      expect(result.isUserImage).toBe(false);
    });

    it("should resolve plain alias via legacy lookup", async () => {
      const result = await resolveImageAlias(testUserId, "test-image");
      expect(result.templateName).toBe(`user-${testUserId}-test-image`);
      expect(result.isUserImage).toBe(true);
    });
  });

  describe("getImageByScopeAndAlias", () => {
    const testUserId = "test-getimage-user";
    const testScopeSlug = `getimg-test-${Date.now()}`;
    let testScopeId: string;

    beforeAll(async () => {
      initServices();

      // Create test scope
      const scope = await createUserScope(testUserId, testScopeSlug);
      testScopeId = scope.id;

      // Create test image
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "scoped-image",
        e2bAlias: `user-${testUserId}-scoped-image`,
        e2bTemplateId: "scoped-template-id",
        e2bBuildId: "scoped-build-id",
        status: "ready",
      });
    });

    afterAll(async () => {
      await globalThis.services.db
        .delete(images)
        .where(eq(images.userId, testUserId));
      await globalThis.services.db
        .delete(scopes)
        .where(eq(scopes.ownerId, testUserId));
    });

    it("should return image when found by scopeId and alias", async () => {
      const image = await getImageByScopeAndAlias(testScopeId, "scoped-image");
      expect(image).toBeDefined();
      expect(image!.alias).toBe("scoped-image");
      expect(image!.scopeId).toBe(testScopeId);
    });

    it("should return null for non-existent alias", async () => {
      const image = await getImageByScopeAndAlias(testScopeId, "nonexistent");
      expect(image).toBeNull();
    });

    it("should return null for non-existent scopeId", async () => {
      const image = await getImageByScopeAndAlias(
        "00000000-0000-0000-0000-000000000000",
        "scoped-image",
      );
      expect(image).toBeNull();
    });
  });
});
