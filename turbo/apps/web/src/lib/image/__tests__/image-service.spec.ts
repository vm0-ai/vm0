/**
 * @vitest-environment node
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  generateE2bAlias,
  isSystemTemplate,
  resolveImageAlias,
  getImageByScopeAndAlias,
  getLatestImage,
  getImageByScopeAliasAndVersion,
  isImageResolutionError,
  listImageVersions,
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

  describe("resolveImageAlias with scope/name and tags", () => {
    const testUserId = "test-image-resolve-user";
    const testScopeSlug = `img-test-${Date.now()}`;
    let testScopeId: string;
    const testVersionId1 = "v1abc123";
    const testVersionId2 = "v2def456";

    beforeAll(async () => {
      initServices();

      // Create test scope for the user
      const scope = await createUserScope(testUserId, testScopeSlug);
      testScopeId = scope.id;

      // Create first version of test image (older)
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "test-image",
        versionId: testVersionId1,
        e2bAlias: `scope-${testScopeId}-image-test-image-version-${testVersionId1}`,
        e2bTemplateId: "test-template-id-v1",
        e2bBuildId: "test-build-id-v1",
        status: "ready",
        createdAt: new Date("2024-01-01"),
      });

      // Create second version of test image (newer - should be :latest)
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "test-image",
        versionId: testVersionId2,
        e2bAlias: `scope-${testScopeId}-image-test-image-version-${testVersionId2}`,
        e2bTemplateId: "test-template-id-v2",
        e2bBuildId: "test-build-id-v2",
        status: "ready",
        createdAt: new Date("2024-01-02"),
      });

      // Create a building image
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "building-image",
        versionId: "build001",
        e2bAlias: `scope-${testScopeId}-image-building-image-version-build001`,
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

    it("should resolve scope/name to latest version", async () => {
      const result = await resolveImageAlias(
        testUserId,
        `${testScopeSlug}/test-image`,
      );
      // Should resolve to the newer version (v2)
      expect(result.templateName).toContain(testVersionId2);
      expect(result.isUserImage).toBe(true);
      expect(result.versionId).toBe(testVersionId2);
    });

    it("should resolve scope/name:latest to latest version", async () => {
      const result = await resolveImageAlias(
        testUserId,
        `${testScopeSlug}/test-image:latest`,
      );
      expect(result.templateName).toContain(testVersionId2);
      expect(result.versionId).toBe(testVersionId2);
    });

    it("should resolve scope/name:versionId to specific version", async () => {
      const result = await resolveImageAlias(
        testUserId,
        `${testScopeSlug}/test-image:${testVersionId1}`,
      );
      expect(result.templateName).toContain(testVersionId1);
      expect(result.versionId).toBe(testVersionId1);
    });

    it("should throw NotFoundError for non-existent scope", async () => {
      await expect(
        resolveImageAlias(testUserId, "nonexistent-scope/test-image"),
      ).rejects.toThrow('Scope "nonexistent-scope" not found');
    });

    it("should throw NotFoundError for non-existent image in scope", async () => {
      await expect(
        resolveImageAlias(testUserId, `${testScopeSlug}/nonexistent`),
      ).rejects.toThrow(`not found`);
    });

    it("should throw NotFoundError for non-existent version", async () => {
      await expect(
        resolveImageAlias(
          testUserId,
          `${testScopeSlug}/test-image:nonexistent`,
        ),
      ).rejects.toThrow("not found");
    });

    it("should throw BadRequestError for version not ready", async () => {
      await expect(
        resolveImageAlias(
          testUserId,
          `${testScopeSlug}/building-image:build001`,
        ),
      ).rejects.toThrow("not ready");
    });

    it("should pass through vm0- prefixed system templates", async () => {
      const result = await resolveImageAlias(testUserId, "vm0-claude-code");
      expect(result.templateName).toBe("vm0-claude-code");
      expect(result.isUserImage).toBe(false);
    });

    it("should resolve plain alias (implicit scope) to latest version", async () => {
      const result = await resolveImageAlias(testUserId, "test-image");
      expect(result.templateName).toContain(testVersionId2);
      expect(result.isUserImage).toBe(true);
    });

    it("should resolve plain alias with tag to specific version", async () => {
      const result = await resolveImageAlias(
        testUserId,
        `test-image:${testVersionId1}`,
      );
      expect(result.templateName).toContain(testVersionId1);
      expect(result.versionId).toBe(testVersionId1);
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

      // Create test image with versionId
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "scoped-image",
        versionId: "ver12345",
        e2bAlias: `scope-${testScopeId}-image-scoped-image-version-ver12345`,
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

  describe("Version query functions", () => {
    const testUserId = "test-version-query-user";
    const testScopeSlug = `ver-test-${Date.now()}`;
    let testScopeId: string;
    // Use hex version IDs (like SHA256 hashes) for realistic testing
    const version1 =
      "a1b2c3d4e5f6789012345678901234567890123456789012345678901234";
    const version2 =
      "b2c3d4e5f6a1789012345678901234567890123456789012345678901234";
    const buildingVersion =
      "c3d4e5f6a1b2789012345678901234567890123456789012345678901234";

    beforeAll(async () => {
      initServices();

      // Create test scope
      const scope = await createUserScope(testUserId, testScopeSlug);
      testScopeId = scope.id;

      // Create older version (ready)
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "versioned-img",
        versionId: version1,
        e2bAlias: `scope-${testScopeId}-image-versioned-img-version-${version1}`,
        e2bTemplateId: "template-v1",
        e2bBuildId: "build-v1",
        status: "ready",
        createdAt: new Date("2024-01-01"),
      });

      // Create newer version (ready - should be latest)
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "versioned-img",
        versionId: version2,
        e2bAlias: `scope-${testScopeId}-image-versioned-img-version-${version2}`,
        e2bTemplateId: "template-v2",
        e2bBuildId: "build-v2",
        status: "ready",
        createdAt: new Date("2024-01-02"),
      });

      // Create a building version (not ready - should not be latest)
      await globalThis.services.db.insert(images).values({
        userId: testUserId,
        scopeId: testScopeId,
        alias: "versioned-img",
        versionId: buildingVersion,
        e2bAlias: `scope-${testScopeId}-image-versioned-img-version-${buildingVersion}`,
        e2bTemplateId: "template-building",
        e2bBuildId: "build-building",
        status: "building",
        createdAt: new Date("2024-01-03"),
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

    describe("getLatestImage", () => {
      it("should return the most recent ready version", async () => {
        const image = await getLatestImage(testScopeId, "versioned-img");
        expect(image).toBeDefined();
        expect(image!.versionId).toBe(version2);
        expect(image!.status).toBe("ready");
      });

      it("should return null for non-existent image", async () => {
        const image = await getLatestImage(testScopeId, "nonexistent");
        expect(image).toBeNull();
      });

      it("should skip non-ready versions", async () => {
        // The building version has a newer createdAt but should be skipped
        const image = await getLatestImage(testScopeId, "versioned-img");
        // Should return version2 (the latest ready version), not the building version
        expect(image!.versionId).toBe(version2);
      });
    });

    describe("getImageByScopeAliasAndVersion", () => {
      it("should return specific version by versionId", async () => {
        const result = await getImageByScopeAliasAndVersion(
          testScopeId,
          "versioned-img",
          version1,
        );
        expect(isImageResolutionError(result)).toBe(false);
        if (!isImageResolutionError(result)) {
          expect(result.image.versionId).toBe(version1);
        }
      });

      it("should return error for non-existent version", async () => {
        const result = await getImageByScopeAliasAndVersion(
          testScopeId,
          "versioned-img",
          "nonexistent",
        );
        expect(isImageResolutionError(result)).toBe(true);
        if (isImageResolutionError(result)) {
          expect(result.status).toBe(404);
          expect(result.error).toContain("not found");
        }
      });

      it("should support prefix matching", async () => {
        // version1 starts with "a1b2c3d4", prefix "a1b2c3d4" should match (8 chars minimum)
        const result = await getImageByScopeAliasAndVersion(
          testScopeId,
          "versioned-img",
          "a1b2c3d4",
        );
        expect(isImageResolutionError(result)).toBe(false);
        if (!isImageResolutionError(result)) {
          expect(result.image.versionId).toBe(version1);
        }
      });

      it("should return error for too short prefix", async () => {
        const result = await getImageByScopeAliasAndVersion(
          testScopeId,
          "versioned-img",
          "a1b2c3", // 6 chars, minimum is 8
        );
        expect(isImageResolutionError(result)).toBe(true);
        if (isImageResolutionError(result)) {
          expect(result.status).toBe(400);
          expect(result.error).toContain("Minimum");
        }
      });
    });

    describe("listImageVersions", () => {
      it("should return all versions ordered by createdAt DESC", async () => {
        const versions = await listImageVersions(testScopeId, "versioned-img");
        expect(versions).toHaveLength(3);
        // Should be ordered newest first
        expect(versions[0]!.versionId).toBe(buildingVersion);
        expect(versions[1]!.versionId).toBe(version2);
        expect(versions[2]!.versionId).toBe(version1);
      });

      it("should return empty array for non-existent image", async () => {
        const versions = await listImageVersions(testScopeId, "nonexistent");
        expect(versions).toHaveLength(0);
      });
    });
  });
});
